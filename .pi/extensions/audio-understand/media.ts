import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type AudioSource = { path: string; start?: number; end?: number };
type Probe = { duration: number; sampleRate: number; channels: number; container: string };
export type InspectedSource = Probe & { path: string; sha256: string; start: number; end: number };
export type SourceRecord = {
  id: string; path: string; sha256: string; sourceDuration: number; start: number; end: number;
  submitted: {
    format: string; sha256: string; bytes: number; duration: number;
    sampleRate: number; channels: number; transformed: boolean;
  };
};
export type PreparedSource = { record: SourceRecord; data: Buffer; mimeType: string };

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
    '-show_entries', 'format=duration,format_name:stream=duration,sample_rate,channels', '-of', 'json', path,
  ], signal);
  const info = JSON.parse(output);
  const stream = info.streams?.[0];
  const duration = Number(stream?.duration ?? info.format?.duration);
  const sampleRate = Number(stream?.sample_rate);
  const channels = Number(stream?.channels);
  if (!stream || !Number.isFinite(duration) || duration <= 0 || !Number.isInteger(sampleRate) || sampleRate <= 0 || !Number.isInteger(channels) || channels <= 0) {
    throw new Error(`A finite, nonempty audio stream is required: ${path}`);
  }
  return { duration, sampleRate, channels, container: info.format?.format_name ?? '' };
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
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new Error('Audio start/end must be finite, nonnegative source seconds.');
    }
  }
  const path = await realpath(resolve(cwd, source.path.replace(/^@/, '')));
  if (!(await stat(path)).isFile()) throw new Error(`Audio source must be a regular file: ${path}`);
  const info = await probe(path, signal);
  const start = source.start ?? 0;
  const end = source.end ?? info.duration;
  if (start >= end || end > info.duration) {
    throw new Error(`Audio range must satisfy 0 <= start < end <= ${info.duration} source seconds: ${path}`);
  }
  return { ...info, path, start, end, sha256: await hashFile(path, signal) };
}

export async function prepareSource(
  source: InspectedSource, index: number, scratch: string, maxEncodedBytes: number, signal: AbortSignal,
): Promise<PreparedSource> {
  const passthrough = ['mp3', 'wav'].includes(source.container) && source.start === 0 && source.end === source.duration;
  const format = source.container === 'mp3' || (!['wav'].includes(source.container) && source.channels <= 2) ? 'mp3' : 'wav';
  let path = source.path;
  if (!passthrough) {
    path = join(scratch, `${index}.${format}`);
    await runFile('ffmpeg', [
      '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', source.path,
      '-ss', String(source.start), '-t', String(source.end - source.start),
      '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1',
      ...(format === 'mp3' ? ['-c:a', 'libmp3lame', '-b:a', '160k'] : ['-c:a', 'pcm_s16le']), path,
    ], signal);
  }
  const size = (await stat(path)).size;
  const encodedBytes = 4 * Math.ceil(size / 3);
  if (encodedBytes > maxEncodedBytes) {
    throw new Error(`Audio needs ${encodedBytes} encoded bytes; remaining maxEncodedAudioBytes is ${maxEncodedBytes}. Select a shorter range or adjust the configured limit.`);
  }
  const data = await readFile(path, { signal });
  const sha256 = createHash('sha256').update(data).digest('hex');
  if ((passthrough ? sha256 : await hashFile(source.path, signal)) !== source.sha256) {
    throw new Error(`Audio changed while preparing the request; retry with a stable file: ${source.path}`);
  }
  const submitted = passthrough ? source : await probe(path, signal);
  signal.throwIfAborted();
  return {
    data, mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    record: {
      id: `source-${index + 1}`, path: source.path, sha256: source.sha256,
      sourceDuration: source.duration, start: source.start, end: source.end,
      submitted: {
        format, sha256, bytes: data.length, duration: submitted.duration,
        sampleRate: submitted.sampleRate, channels: submitted.channels, transformed: !passthrough,
      },
    },
  };
}
