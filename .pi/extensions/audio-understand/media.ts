import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type AudioSource = { path: string; start?: number; end?: number };
type Probe = { duration: number; sampleRate: number; channels: number; container: string; startTime: number; codec: string };
export type InspectedSource = Probe & { path: string; sha256: string; start: number; end: number; requested: { start?: number; end?: number } };
export type SourceRecord = {
  id: string; path: string; sha256: string; sourceDuration: number; start: number; end: number;
  requested: { start?: number; end?: number };
  submitted: {
    format: string; sha256: string; bytes: number; duration: number; start: number; end: number;
    sampleRate: number; channels: number; transformed: boolean;
  };
};
export type PreparedSource = { record: SourceRecord; path: string; mimeType: string };

export async function runFile(command: string, args: string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((accept, reject) => {
    execFile(command, args, { signal, encoding: 'utf8', maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(new Error(`${command} failed (${(error as { code?: string | number }).code ?? 'unknown'}). Check the local media and executable.`));
      else accept(stdout);
    });
  });
}

async function probe(path: string, signal: AbortSignal): Promise<Probe> {
  const output = await runFile('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0',
    '-show_entries', 'format=duration,format_name:stream=duration,sample_rate,channels,start_time,codec_name', '-of', 'json', path,
  ], signal);
  const info = JSON.parse(output);
  const stream = info.streams?.[0];
  const duration = Number(stream?.duration ?? info.format?.duration);
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  if (!stream || !Number.isFinite(duration) || duration <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels <= 0) {
    throw new Error(`A finite, nonempty audio stream is required: ${path}`);
  }
  return { duration, sampleRate, channels, container: info.format?.format_name ?? '', startTime: Number(stream.start_time) || 0, codec: stream.codec_name ?? '' };
}

async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  signal.throwIfAborted();
  return hash.digest('hex');
}

export async function inspectSource(source: AudioSource, cwd: string, signal: AbortSignal): Promise<InspectedSource> {
  if (!source || typeof source.path !== 'string' || !source.path.trim()) throw new Error('Each audio source requires a local path.');
  for (const value of [source.start, source.end]) {
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Audio start/end must be finite source seconds.');
    }
  }
  const path = await realpath(resolve(cwd, source.path.replace(/^@/, '')));
  if (!(await stat(path)).isFile()) throw new Error(`Audio source must be a regular file: ${path}`);
  const info = await probe(path, signal);
  if (info.container === 'mp3') {
    const timing = await mp3Timing(path, info.sampleRate, signal);
    info.duration = timing.duration;
    info.startTime = timing.start;
  }
  const clamp = (value: number) => Math.max(0, Math.min(info.duration, value));
  const start = clamp(source.start ?? 0);
  const end = clamp(source.end ?? info.duration);
  if (start >= end) {
    throw new Error(`Audio range is empty or reversed after clamping to [0, ${info.duration}] source seconds: ${path}`);
  }
  return { ...info, path, start, end, requested: { start: source.start, end: source.end }, sha256: await hashFile(path, signal) };
}

// Streaming packet metadata bounds memory even for long inputs. MP3 timestamps include encoder delay.
async function mp3Timing(path: string, sampleRate: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = spawn('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0', '-show_packets',
    '-show_entries', 'packet=pts_time,duration_time:packet_side_data=skip_samples,discard_padding', '-of', 'compact=p=0', path,
  ], { signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] });
  const done = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? accept() : reject(new Error('MP3 packet timing could not be verified.')));
  });
  // Observe process errors while its stdout is still being consumed.
  void done.catch(() => {});
  let first: number | undefined;
  let skip = 0;
  let end = 0;
  for await (const line of createInterface({ input: child.stdout })) {
    const fields = Object.fromEntries(line.split('|').map(field => {
      const [key, value] = field.split('=');
      return [key.split(':').at(-1)!, Number(value)];
    }));
    if (!Number.isFinite(fields.pts_time) || !Number.isFinite(fields.duration_time)) continue;
    if (first === undefined) { first = fields.pts_time; skip = fields.skip_samples || 0; }
    end = fields.pts_time + fields.duration_time - (fields.discard_padding || 0) / sampleRate;
  }
  await done;
  signal.throwIfAborted();
  const start = (first ?? NaN) + skip / sampleRate;
  if (!Number.isFinite(start) || end <= start) throw new Error('MP3 audible interval could not be verified.');
  return { start, duration: end - start };
}

async function packetHashes(path: string, interval: string, signal: AbortSignal) {
  const output = await runFile('ffprobe', [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0', '-read_intervals', interval,
    '-show_packets', '-show_entries', 'packet=pts_time,data_hash', '-show_data_hash', 'sha256', '-of', 'json', path,
  ], signal);
  return JSON.parse(output).packets as { pts_time: string; data_hash: string }[];
}

export async function prepareSource(
  source: InspectedSource, index: number, scratch: string, maxEncodedBytes: number, signal: AbortSignal,
): Promise<PreparedSource> {
  const id = `source-${index + 1}`;
  const passthrough = ['mp3', 'wav'].includes(source.container) && source.start === 0 && source.end === source.duration;
  const format = source.container === 'mp3' || (source.container !== 'wav' && source.channels <= 2) ? 'mp3' : 'wav';
  let path = source.path;
  // Pre-roll also provides MP3 bit-reservoir context; the verified mapping below uses audible samples.
  const copyMp3 = !passthrough && source.container === 'mp3';
  const cutStart = copyMp3 ? Math.max(0, source.start - 0.25) : Math.floor(source.start * source.sampleRate) / source.sampleRate;
  const cutEnd = copyMp3 ? Math.min(source.duration, source.end + 0.1) : Math.ceil(source.end * source.sampleRate) / source.sampleRate;
  if (!passthrough) {
    path = join(scratch, `${index}.${format}`);
    await runFile('ffmpeg', [
      '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', source.path,
      ...(cutStart > 0 ? ['-ss', String(cutStart)] : []),
      ...(cutEnd < source.duration ? ['-t', String(cutEnd - cutStart)] : []),
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
      ...(copyMp3 ? ['-c:a', 'copy'] : format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '160k']
        : ['-c:a', source.container === 'wav' && source.codec.startsWith('pcm_') ? source.codec : 'pcm_s16le']), path,
    ], signal);
  }
  const size = (await stat(path)).size;
  const encodedBytes = 4 * Math.ceil(size / 3);
  if (encodedBytes > maxEncodedBytes) {
    throw new Error(`${id} needs ${encodedBytes} Base64 audio bytes; per-upload maxEncodedAudioBytes is ${maxEncodedBytes}. Select a shorter range or adjust the configured service limit. 0 uploads.`);
  }
  const submitted = passthrough ? source : await probe(path, signal);
  let start = passthrough ? 0 : cutStart;
  let duration = submitted.duration;
  if (format === 'mp3' && !passthrough) {
    const timing = await mp3Timing(path, submitted.sampleRate, signal);
    duration = timing.duration;
    if (copyMp3) {
      const [packet] = await packetHashes(path, '%+#1', signal);
      const candidates = await packetHashes(source.path, `${Math.max(0, cutStart - 1)}%${Math.min(source.duration, cutStart + 1)}`, signal);
      const threshold = cutStart > 0 ? cutStart + source.startTime : 0;
      const first = candidates.find(candidate => Number(candidate.pts_time) >= threshold - 0.000001);
      if (!first || first.data_hash !== packet?.data_hash) {
        throw new Error(`${id} MP3 source-time mapping could not be verified. Select another range or supply WAV. 0 uploads.`);
      }
      start = Number(first.pts_time) - source.startTime + timing.start;
    }
  }
  const end = start + duration;
  const tolerance = 1 / submitted.sampleRate + 0.00001;
  if (start > source.start + tolerance || end < source.end - tolerance) {
    throw new Error(`${id} prepared audio covers [${start}, ${end}), shorter than [${source.start}, ${source.end}). Select another range or supply WAV. 0 uploads.`);
  }
  const sha256 = await hashFile(path, signal);
  if ((passthrough ? sha256 : await hashFile(source.path, signal)) !== source.sha256) {
    throw new Error(`Audio changed while preparing the request; retry with a stable file: ${source.path}`);
  }
  signal.throwIfAborted();
  return {
    path, mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    record: {
      id, path: source.path, sha256: source.sha256, requested: source.requested,
      sourceDuration: source.duration, start: source.start, end: source.end,
      submitted: {
        format, sha256, bytes: size, duration, start, end,
        sampleRate: submitted.sampleRate, channels: submitted.channels, transformed: !passthrough,
      },
    },
  };
}
