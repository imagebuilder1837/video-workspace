import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createAudioUnderstanding } from '../understand.ts';

// A known waveform makes cropping observable without cloud inference or checked-in media.
function wave(frequency = 440): Buffer {
  const samples = 3 * 8000;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const hz = i < 8000 ? frequency : frequency * 2;
    data.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * hz * i / 8000)), 44 + i * 2);
  }
  return data;
}

function pcm(wav: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  throw new Error('No audio data in fixture response');
}

const completion = (answer = 'A bright, steady texture.') => Response.json({
  id: 'response-1', model: 'resolved-model', choices: [{ finish_reason: 'stop', message: { content: answer } }],
  usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42, prompt_tokens_details: { audio_tokens: 21, cached_tokens: 0 } },
});

type CapturedCall = { url: string; init: RequestInit; body: any };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'audio-understand-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const temporaryRoot = join(root, 'temporary');
  await mkdir(join(root, '.pi')); await mkdir(temporaryRoot);
  const audio = join(root, 'tone; local.wav');
  const original = wave();
  await writeFile(audio, original);
  let config = { baseUrl: 'https://audio.invalid/v1', model: 'test-audio', apiKeyEnv: 'AUDIO_TEST_KEY', requestParams: {} };
  const configure = async (changes: Record<string, unknown> = {}) => {
    config = { ...config, ...changes };
    await writeFile(join(root, '.pi', 'audio-understand.local.json'), JSON.stringify(config));
  };
  await configure();
  const env: Record<string, string | undefined> = { AUDIO_TEST_KEY: 'secret-only-in-header' };
  const calls: CapturedCall[] = [];
  let handler = async (_call: CapturedCall): Promise<Response> => completion();
  const fetchImpl: typeof fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return handler(call);
  };
  const options = { env, temporaryRoot };
  return {
    root, audio, original, calls, env, temporaryRoot, configure,
    ask: createAudioUnderstanding(root, { ...options, fetch: fetchImpl }),
    askWithRealHttp: createAudioUnderstanding(root, options),
    respond: (next: typeof handler) => { handler = next; },
    request: { sources: [{ path: audio }], question: 'Describe the sound.' },
  };
}

test('sends the requested samples and question for multiple sources, preserving source coordinates and usage', async (t) => {
  const f = await fixture(t);
  await f.configure({ baseUrl: 'https://other.invalid/compatible-mode/v1/', model: 'another-audio-model', requestParams: { max_tokens: 321, temperature: 0 } });
  const question = 'Compare source-1 and source-2; describe the differences in a table.';
  const result = await f.ask({ sources: [{ path: 'tone; local.wav', start: 1, end: 2 }, { path: f.audio }], question }, { cwd: f.root });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, 'https://other.invalid/compatible-mode/v1/chat/completions');
  assert.equal(new Headers(call.init.headers).get('authorization'), `Bearer ${f.env.AUDIO_TEST_KEY}`);
  assert.equal(call.body.model, 'another-audio-model');
  assert.equal(call.body.max_tokens, 321);
  const content = call.body.messages[0].content;
  assert.equal(content.at(-1).text, question);
  const audio = content.filter((item: any) => item.type === 'input_audio');
  assert.equal(audio.length, 2);
  const decoded = audio.map((item: any) => Buffer.from(item.input_audio.data.split(',')[1], 'base64'));
  assert.deepEqual(pcm(decoded[0]), pcm(f.original).subarray(16000, 32000));
  assert.deepEqual(decoded[1], f.original);
  assert.equal(JSON.stringify(call.body).includes(f.audio), false);
  assert.equal(result.answer, 'A bright, steady texture.');
  assert.equal(result.sources[0].start, 1);
  assert.equal(result.sources[0].end, 2);
  assert.equal(result.sources[0].submitted.duration, 1);
  assert.equal(result.sources[0].submitted.transformed, true);
  assert.equal(result.sources[1].submitted.transformed, false);
  assert.equal(result.usage?.audioInputTokens, 21);
  assert.equal(result.responseModel, 'resolved-model');
  const saved = await readFile(result.cache.reportPath!, 'utf8');
  assert.equal(saved.includes(f.env.AUDIO_TEST_KEY!), false);
  assert.equal(saved.includes(f.original.toString('base64')), false);
  assert.deepEqual(await readdir(f.temporaryRoot), []);
});

test('uses a configured API key before the environment key, supports key-only configuration, and keeps it out of reports and cache identity', async (t) => {
  const f = await fixture(t);
  const key = 'local-config-secret';
  await f.configure({ apiKey: key });
  f.respond(async () => completion(`${key}: useful description`));
  const first = await f.ask(f.request);
  assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), `Bearer ${key}`);
  assert.equal(JSON.stringify(first).includes(key), false);
  assert.equal((await readFile(first.cache.reportPath!, 'utf8')).includes(key), false);
  await f.configure({ apiKey: 'rotated-local-secret' });
  assert.equal((await f.ask(f.request)).cache.hit, true);
  await f.configure({ apiKeyEnv: undefined });
  delete f.env.AUDIO_TEST_KEY;
  await f.ask({ ...f.request, question: 'A fresh question' });
  assert.equal(new Headers(f.calls[1].init.headers).get('authorization'), 'Bearer rotated-local-secret');
  await f.configure({ apiKey: '', apiKeyEnv: 'AUDIO_TEST_KEY' });
  f.env.AUDIO_TEST_KEY = 'environment-fallback';
  await f.ask({ ...f.request, question: 'Another question' });
  assert.equal(new Headers(f.calls[2].init.headers).get('authorization'), 'Bearer environment-fallback');
});

test('sends decodable MP3 for a music excerpt and for a source requiring format conversion', async (t) => {
  const f = await fixture(t);
  const mp3 = join(f.root, 'music.mp3');
  const flac = join(f.root, 'music.flac');
  for (const path of [mp3, flac]) execFileSync('ffmpeg', ['-v', 'error', '-i', f.audio, path]);
  const result = await f.ask({ sources: [{ path: mp3, start: 1, end: 2 }, { path: flac }], question: 'Compare these sounds.' });
  const audio = f.calls[0].body.messages[0].content.filter((item: any) => item.type === 'input_audio');
  for (const [index, item] of audio.entries()) {
    assert.equal(item.input_audio.format, 'mp3');
    const decoded = execFileSync('ffmpeg', ['-v', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1'], {
      input: Buffer.from(item.input_audio.data.split(',')[1], 'base64'),
    });
    const duration = decoded.length / 16000;
    assert.ok(duration >= (index === 0 ? 1 : 3) && duration < (index === 0 ? 1.5 : 3.5));
    assert.equal(result.sources[index].submitted.transformed, true);
  }
});

test('reuses an identical local answer even without a current API key, and re-asks when evidence or configuration changes', async (t) => {
  const f = await fixture(t);
  const first = await f.ask(f.request);
  delete f.env.AUDIO_TEST_KEY;
  const cached = await f.ask(f.request);
  assert.equal(cached.cache.hit, true);
  assert.equal(cached.answer, first.answer);
  assert.equal(f.calls.length, 1);
  f.env.AUDIO_TEST_KEY = 'secret-only-in-header';
  await f.ask({ ...f.request, question: 'How does its energy change?' });
  await f.ask({ ...f.request, sources: [{ path: f.audio, start: 1, end: 2 }] });
  await writeFile(f.audio, wave(220));
  await f.ask(f.request);
  await f.configure({ model: 'changed-model' });
  await f.ask(f.request);
  await f.configure({ requestParams: { temperature: 0.2 } });
  await f.ask(f.request);
  await f.configure({ baseUrl: 'https://changed.invalid/v1' });
  await f.ask(f.request);
  assert.equal(f.calls.length, 7);
});

test('refreshes unreadable JSON caches and supports explicitly fresh requests', async (t) => {
  const f = await fixture(t);
  const first = await f.ask(f.request);
  for (const broken of ['interrupted JSON', 'null']) {
    await writeFile(first.batches[0].cache!.reportPath!, broken);
    assert.equal((await f.ask(f.request)).cache.hit, false);
  }
  await f.configure({ limits: { cacheMaxAgeMs: 0 } });
  assert.equal((await f.ask(f.request)).cache.hit, false);
  assert.equal((await f.ask(f.request)).cache.hit, false);
  assert.equal(f.calls.length, 5);
});

test('rejects invalid media/ranges and a single oversized source before any upload', async (t) => {
  const f = await fixture(t);
  for (const source of [
    { path: f.audio, start: 2, end: 1 }, { path: f.audio, start: 4 }, { path: f.audio, end: -1 },
    { path: f.audio, start: NaN }, { path: f.root },
  ]) await assert.rejects(f.ask({ ...f.request, sources: [source] }));
  await f.configure({ limits: { maxEncodedAudioBytes: 4 * Math.ceil(f.original.length / 3) - 1 } });
  await assert.rejects(f.ask({ ...f.request, sources: [{ path: f.audio, start: 0, end: 1 }, { path: f.audio }] }), /source-2.*Base64.*maxEncodedAudioBytes.*0 uploads/);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await readdir(f.temporaryRoot), []);
});

test('reports missing configuration, credentials and reserved request parameters without transmitting audio', async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, '.pi', 'audio-understand.local.json'));
  await assert.rejects(f.ask(f.request), /Configure/);
  await f.configure();
  delete f.env.AUDIO_TEST_KEY;
  assert.match((await f.ask(f.request)).batches[0].error!, /AUDIO_TEST_KEY/);
  f.env.AUDIO_TEST_KEY = 'secret-only-in-header';
  for (const requestParams of [{ messages: [] }, { stream: true }, { tools: [] }]) {
    await f.configure({ requestParams });
    await assert.rejects(f.ask(f.request), /requestParams/);
  }
  assert.equal(f.calls.length, 0);
});

test('reports HTTP failure without leaking its body, retrying or caching a failed answer', async (t) => {
  const f = await fixture(t);
  f.respond(async () => new Response(`${f.env.AUDIO_TEST_KEY} ${f.original.toString('base64')}`, { status: 429 }));
  const failed = await f.ask(f.request);
  assert.equal(failed.status, 'failed');
  assert.match(failed.batches[0].error!, /HTTP 429/);
  assert.equal(JSON.stringify(failed).includes(f.env.AUDIO_TEST_KEY!), false);
  assert.equal(JSON.stringify(failed).includes(f.original.toString('base64')), false);
  assert.equal(f.calls.length, 1);
  f.respond(async () => completion('Recovered answer'));
  assert.equal((await f.ask(f.request)).answer, 'Recovered answer');
  assert.equal(f.calls.length, 2);
});

test('requires a complete text answer rather than treating invalid JSON, tool calls or truncated text as success', async (t) => {
  const f = await fixture(t);
  const replies = [
    () => new Response('data: streaming is not this protocol'),
    () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }),
    () => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [{}] } }] }),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
  ];
  for (const reply of replies) {
    f.respond(async () => reply());
    assert.match((await f.ask(f.request)).batches[0].error!, /Audio service/);
  }
  f.respond(async () => completion());
  assert.equal((await f.ask(f.request)).cache.hit, false);
  assert.equal(f.calls.length, replies.length + 1);
});

test('redacts credentials and echoed inline audio from model output and saved reports', async (t) => {
  const f = await fixture(t);
  f.respond(async (call) => {
    const audio = call.body.messages[0].content.find((item: any) => item.type === 'input_audio');
    return completion(`${f.env.AUDIO_TEST_KEY}\n${audio.input_audio.data}\nUseful description`);
  });
  const result = await f.ask(f.request);
  assert.match(result.answer, /Useful description/);
  assert.equal(result.answer.includes(f.env.AUDIO_TEST_KEY!), false);
  assert.equal(result.answer.includes(f.original.toString('base64')), false);
  assert.equal((await readFile(result.cache.reportPath!, 'utf8')).includes(f.env.AUDIO_TEST_KEY!), false);
});

test('cancels an in-flight request, removes temporary audio, and leaves the question available for an explicit retry', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.respond(async (call) => {
    controller.abort();
    await delay(10000, undefined, { signal: call.init.signal! });
    return completion();
  });
  const request = { ...f.request, sources: [{ path: f.audio, start: 1, end: 2 }] };
  const cancelled = await f.ask(request, { signal: controller.signal });
  assert.equal(cancelled.status, 'failed');
  assert.match(cancelled.batches[0].error!, /cancelled.*charged/);
  assert.deepEqual(await readdir(f.temporaryRoot), []);
  f.respond(async () => completion());
  assert.equal((await f.ask(request)).cache.hit, false);
  assert.equal(f.calls.length, 2);
});

test('applies the total deadline to a slow response', async (t) => {
  const f = await fixture(t);
  await f.configure({ limits: { timeoutMs: 1000 } });
  f.respond(async (call) => {
    await delay(10000, undefined, { signal: call.init.signal! });
    return completion();
  });
  const timedOut = await f.ask(f.request);
  assert.equal(timedOut.status, 'failed');
  assert.match(timedOut.batches[0].error!, /timed out.*charged/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await readdir(f.temporaryRoot), []);
});

test('clamps finite requested ranges to source bounds and preserves the original request', async (t) => {
  const f = await fixture(t);
  const result = await f.ask({ ...f.request, sources: [{ path: f.audio, start: -10, end: 20 }, { path: f.audio, end: 1.5 }] });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.sources[0].requested, { start: -10, end: 20 });
  assert.equal(result.sources[0].start, 0);
  assert.equal(result.sources[0].end, 3);
  assert.equal(result.sources[0].submitted.transformed, false);
  assert.equal(result.sources[1].start, 0);
  assert.equal(result.sources[1].end, 1.5);
  const content = f.calls[0].body.messages[0].content;
  assert.deepEqual(Buffer.from(content[1].input_audio.data.split(',')[1], 'base64'), f.original);
});

test('batches whole sources at the Base64 boundary, preserving global IDs and per-batch cache', async (t) => {
  const f = await fixture(t);
  const bytes = 4 * Math.ceil(f.original.length / 3);
  await f.configure({ limits: { maxEncodedAudioBytes: bytes * 2 } });
  const request = { ...f.request, sources: Array.from({ length: 5 }, () => ({ path: f.audio })) };
  let active = 0;
  f.respond(async () => {
    assert.equal(active++, 0);
    await delay(5);
    active--;
    return completion(`Answer ${f.calls.length}`);
  });
  const result = await f.ask(request);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.batches.map(b => b.sourceIds), [['source-1', 'source-2'], ['source-3', 'source-4'], ['source-5']]);
  assert.deepEqual(result.batches.map(b => b.encodedAudioBytes), [bytes * 2, bytes * 2, bytes]);
  assert.equal(f.calls.length, 3);
  for (const [index, call] of f.calls.entries()) {
    const content = call.body.messages[0].content;
    assert.deepEqual(content.filter((c: any) => c.type === 'text').slice(0, -1).map((c: any) => c.text.split(':')[0]), result.batches[index].sourceIds);
    assert.equal(content.at(-1).text, request.question);
  }
  assert.equal(result.usage?.totalTokens, 126);
  delete f.env.AUDIO_TEST_KEY;
  const cached = await f.ask(request);
  assert.equal(cached.cache.hit, true);
  assert.ok(cached.batches.every(b => b.status === 'completed' && b.cache?.hit));
  assert.equal(f.calls.length, 3);
});

test('accepts a single source larger than 3 MB within its configured upload budget', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'large.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=40', '-ar', '44100', path]);
  const result = await f.ask({ ...f.request, sources: [{ path }] });
  assert.equal(result.status, 'completed');
  assert.ok(result.sources[0].submitted.bytes > 3000000);
  assert.equal(f.calls.length, 1);
});

test('stops after a failed batch, reports coverage, and reuses completed batches on explicit retry', async (t) => {
  const f = await fixture(t);
  await f.configure({ limits: { maxEncodedAudioBytes: 4 * Math.ceil(f.original.length / 3) } });
  const request = { ...f.request, sources: Array.from({ length: 3 }, () => ({ path: f.audio })) };
  f.respond(async () => f.calls.length === 2 ? new Response('', { status: 503 }) : completion());
  const partial = await f.ask(request);
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.batches.map(b => b.status), ['completed', 'failed', 'not_sent']);
  assert.match(partial.batches[1].error!, /HTTP 503/);
  assert.equal(f.calls.length, 2);
  const saved = JSON.parse(await readFile(partial.cache.reportPath!, 'utf8'));
  assert.equal(saved.result.status, 'partial');
  f.respond(async () => completion());
  const retry = await f.ask(request);
  assert.equal(retry.status, 'completed');
  assert.equal(retry.batches[0].cache?.hit, true);
  assert.equal(f.calls.length, 4);
});

test('keeps one total deadline across batches and preserves completed work at timeout', async (t) => {
  const f = await fixture(t);
  await f.configure({ limits: { timeoutMs: 1800, maxEncodedAudioBytes: 4 * Math.ceil(f.original.length / 3) } });
  const request = { ...f.request, sources: Array.from({ length: 3 }, () => ({ path: f.audio })) };
  f.respond(async (call) => {
    await delay(1000, undefined, { signal: call.init.signal! });
    return completion();
  });
  const result = await f.ask(request);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.batches.map(b => b.status), ['completed', 'failed', 'not_sent']);
  assert.match(result.batches[1].error!, /timed out.*charged/);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(await readdir(f.temporaryRoot), []);
});

test('copies MP3 frames with outward coverage and reports the audible source-time mapping', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'original.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-i', f.audio, '-c:a', 'libmp3lame', '-b:a', '64k', path]);
  const result = await f.ask({ ...f.request, sources: [{ path, start: 1.013, end: 2.017 }] });
  const source = result.sources[0];
  assert.equal(source.start, 1.013);
  assert.equal(source.end, 2.017);
  assert.ok(source.submitted.start <= source.start);
  assert.ok(source.submitted.end >= source.end);
  assert.ok(source.start - source.submitted.start < 0.5);
  assert.ok(source.submitted.end - source.end < 0.5);
  const item = f.calls[0].body.messages[0].content.find((c: any) => c.type === 'input_audio');
  const clip = join(f.root, 'submitted.mp3');
  await writeFile(clip, Buffer.from(item.input_audio.data.split(',')[1], 'base64'));
  const packets = (file: string) => JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=data_hash',
    '-show_data_hash', 'sha256', '-of', 'json', file,
  ], { encoding: 'utf8' })).packets.map((p: any) => p.data_hash);
  const originalHashes = packets(path);
  const copiedHashes = packets(clip);
  const offset = originalHashes.indexOf(copiedHashes[0]);
  assert.ok(offset >= 0);
  assert.deepEqual(copiedHashes, originalHashes.slice(offset, offset + copiedHashes.length));
  const decode = (file: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1']);
  const decoded = decode(clip);
  const originalPcm = decode(path);
  const sourceOffset = Math.round(source.submitted.start * 8000);
  const clipOffset = Math.round((source.start - source.submitted.start) * 8000);
  assert.deepEqual(decoded.subarray(clipOffset * 2, (clipOffset + 2000) * 2), originalPcm.subarray((sourceOffset + clipOffset) * 2, (sourceOffset + clipOffset + 2000) * 2));
  assert.ok(Math.abs(decoded.length / 16000 - source.submitted.duration) < 0.001);
  assert.ok(Math.abs(source.submitted.end - source.submitted.start - source.submitted.duration) < 0.00001);
  assert.match(f.calls[0].body.messages[0].content[0].text, new RegExp(String(source.submitted.start).replace('.', '\\.')));
});

test('cached batch reuse keeps the original expiry time', async (t) => {
  const f = await fixture(t);
  const first = await f.ask(f.request);
  const path = first.batches[0].cache!.reportPath!;
  const entry = JSON.parse(await readFile(path, 'utf8'));
  entry.result.createdAt = new Date(Date.now() - 60000).toISOString();
  await writeFile(path, JSON.stringify(entry));
  assert.equal((await f.ask(f.request)).cache.hit, true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).result.createdAt, entry.result.createdAt);
  await f.configure({ limits: { cacheMaxAgeMs: 30000 } });
  assert.equal((await f.ask(f.request)).cache.hit, false);
  assert.equal(f.calls.length, 2);
});

test('preserves 24-bit PCM samples when cropping WAV', async (t) => {
  const f = await fixture(t);
  const original = join(f.root, '24bit.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'pcm_s24le', original]);
  const decode = (args: string[], input?: Buffer) => execFileSync('ffmpeg', ['-v', 'error', ...args, '-f', 's24le', 'pipe:1'], { input });
  const result = await f.ask({ ...f.request, sources: [{ path: original, start: 1, end: 2 }] });
  assert.equal(result.status, 'completed');
  const audio = f.calls[0].body.messages[0].content.find((c: any) => c.type === 'input_audio');
  const wav = Buffer.from(audio.input_audio.data.split(',')[1], 'base64');
  assert.deepEqual(decode(['-i', 'pipe:0'], wav), decode(['-i', original, '-ss', '1', '-t', '1']));
});

test('covers MP3 requests at both source boundaries and preserves whole-file bytes', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'bounds.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-i', f.audio, '-c:a', 'libmp3lame', path]);
  const result = await f.ask({ ...f.request, sources: [
    { path, start: -1, end: 1.01 }, { path, start: 2.01, end: 100 }, { path, end: 100 },
  ] });
  assert.equal(result.status, 'completed');
  for (const source of result.sources) {
    assert.ok(source.submitted.start <= source.start + 0.0001);
    assert.ok(source.submitted.end >= source.end - 0.0001);
  }
  const content = f.calls[0].body.messages[0].content.filter((c: any) => c.type === 'input_audio');
  assert.deepEqual(Buffer.from(content[2].input_audio.data.split(',')[1], 'base64'), await readFile(path));
});

test('uses audible MP3 duration when clamping beyond an approximate container duration', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'unindexed.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=4', '-c:a', 'libmp3lame', '-q:a', '4', '-write_xing', '0', path]);
  const result = await f.ask({ ...f.request, sources: [{ path, start: -1, end: 100 }] });
  assert.equal(result.status, 'completed');
  const decoded = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '44100', 'pipe:1']);
  assert.ok(Math.abs(result.sources[0].end - decoded.length / 88200) < 0.0001);
});

test('maps copied MP3 frames across sample rates, VBR and repeated silent packets', async (t) => {
  const f = await fixture(t);
  for (const [rate, sound, codecArgs] of [
    [44100, 'sine=duration=4', ['-b:a', '128k']],
    [48000, 'sine=duration=4', ['-q:a', '3']],
    [8000, 'anullsrc=r=8000:cl=mono:d=4', ['-b:a', '32k']],
  ] as const) {
    const path = join(f.root, `${rate}.mp3`);
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', sound, '-ar', String(rate), '-c:a', 'libmp3lame', ...codecArgs, path]);
    const result = await f.ask({ ...f.request, sources: [{ path, start: 1.013, end: 2.017 }] });
    assert.equal(result.status, 'completed');
    const source = result.sources[0];
    assert.ok(source.submitted.start <= source.start);
    assert.ok(source.submitted.end >= source.end);
  }
});

test('does not follow an HTTP redirect to another upload destination', async (t) => {
  const f = await fixture(t);
  let redirectedCalls = 0;
  const destination = createServer((_req, res) => { redirectedCalls++; res.end('unexpected upload'); });
  const redirect = createServer((_req, res) => {
    const address = destination.address() as { port: number };
    res.writeHead(307, { location: `http://127.0.0.1:${address.port}/chat/completions` }); res.end();
  });
  for (const server of [destination, redirect]) {
    await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
    t.after(() => new Promise<void>((accept, reject) => {
      server.closeAllConnections(); server.close((error) => error ? reject(error) : accept());
    }));
  }
  await f.configure({ baseUrl: `http://127.0.0.1:${(redirect.address() as { port: number }).port}` });
  assert.match((await f.askWithRealHttp(f.request)).batches[0].error!, /connection failed/);
  assert.equal(redirectedCalls, 0);
});
