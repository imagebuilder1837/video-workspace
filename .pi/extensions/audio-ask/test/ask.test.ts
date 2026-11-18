import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createAudioAsk } from '../ask.ts';
import { createTools } from '../index.ts';
import { rebuildIndexes } from '../archive.ts';
import { migrateLegacy } from '../maintenance.ts';

function wave(): Buffer {
  const samples = 3 * 8000;
  const data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * (i < 8000 ? 440 : 880) * i / 8000)), 44 + i * 2);
  return data;
}
function pcm(wav: Buffer): Buffer {
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data') return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  throw new Error('Expected PCM data');
}
const completion = (answer = 'The bass enters with a darker pulse.') => Response.json({
  id: 'response-1', model: 'resolved-model', choices: [{ finish_reason: 'stop', message: { content: answer } }],
  usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42, prompt_tokens_details: { audio_tokens: 21 } },
});
type Call = { body: any; init: RequestInit };
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pi-audio-ask-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.pi'));
  const temporaryRoot = join(root, 'temporary'); await mkdir(temporaryRoot);
  const original = wave();
  const audio = join(root, 'tone; local.wav'); await writeFile(audio, original);
  const config: any = { baseUrl: 'https://audio.invalid/v1', model: 'test-audio', apiKey: 'test-secret', audioDataFormat: 'data-url', retry: { maxAttempts: 3, baseDelayMs: 0 } };
  const configure = async (changes: Record<string, unknown> = {}) => {
    Object.assign(config, changes);
    await writeFile(join(root, '.pi', 'audio-ask.local.json'), JSON.stringify(config));
  };
  await configure();
  const calls: Call[] = [];
  let handler = async (_call: Call): Promise<Response> => completion();
  const fetchImpl: typeof fetch = async (_url, init = {}) => {
    const call = { body: JSON.parse(String(init.body)), init }; calls.push(call); return handler(call);
  };
  return {
    root, audio, original, calls, temporaryRoot, configure, config,
    engine: createAudioAsk(root, { fetch: fetchImpl, temporaryRoot }),
    respond: (next: typeof handler) => { handler = next; },
    request: { title: '低频与动作', question: 'Focus on the bass; what could guide the movement?', sources: [{ path: audio }] },
  };
}

// Each test follows a caller-visible workflow; shared media preparation retains its signal-level regression checks.
test('joint consultations send actual selected audio, stay fresh, and archive searchable answers with provenance', async t => {
  const f = await fixture(t);
  f.respond(async call => {
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer test-secret');
    assert.equal(call.body.messages[0].content.at(-1).text, f.request.question);
    assert.equal(call.body.model, 'test-audio');
    return completion(`test-secret ${call.body.messages[0].content.find((p: any) => p.type === 'input_audio').input_audio.data}\nUseful bass observation.`);
  });
  const request = { ...f.request, sources: [{ path: f.audio, start: 1, end: 2, label: '动作段' }, { path: f.audio }] };
  const first = await f.engine.ask(request);
  const second = await f.engine.ask(request);
  assert.equal(f.calls.length, 2);
  assert.notEqual(first.consultation.id, second.consultation.id);
  assert.equal(first.consultation.status, 'completed');
  const content = f.calls[0].body.messages[0].content;
  const bytes = content.filter((p: any) => p.type === 'input_audio').map((p: any) => Buffer.from(p.input_audio.data.split(',')[1], 'base64'));
  assert.deepEqual(pcm(bytes[0]), pcm(f.original).subarray(16000, 32000));
  assert.deepEqual(bytes[1], f.original);
  assert.equal(JSON.stringify(f.calls[0].body).includes(f.audio), false);
  assert.equal(first.consultation.batches[0].usage?.audioInputTokens, 21);
  assert.equal(first.consultation.batches[0].responseModel, 'resolved-model');
  const saved = await readFile(first.archive.recordPath, 'utf8');
  assert.equal(saved.includes('test-secret'), false);
  assert.equal(saved.includes(f.original.toString('base64')), false);
  assert.match(await readFile(first.archive.reportPath, 'utf8'), /Useful bass observation/);
  const sha = createHash('sha256').update(f.original).digest('hex');
  const index = await readFile(join(f.root, '.media/audio-ask/assets', sha, 'index.md'), 'utf8');
  assert.ok(index.includes(first.consultation.id) && index.includes(second.consultation.id));
  assert.deepEqual(await readdir(f.temporaryRoot), []);
  await f.configure({ limits: { maxEncodedAudioBytes: 10 } });
  const over = await f.engine.ask(request);
  assert.equal(over.consultation.status, 'failed');
  assert.equal(f.calls.length, 2);
});

test('batch packing keeps multi-excerpt groups together, skips local problems and persists before the next request', async t => {
  const f = await fixture(t);
  const bytes = 4 * Math.ceil(f.original.length / 3);
  await f.configure({ limits: { maxEncodedAudioBytes: bytes * 2, maxItemsPerRequest: 2 } });
  const idOf = (call: Call) => call.body.messages[0].content[0].text;
  f.respond(async call => {
    if (f.calls.length > 1) {
      const records = await readdir(join(f.root, '.media/audio-ask/records'));
      const saved = JSON.parse(await readFile(join(f.root, '.media/audio-ask/records', records[0], 'record.json'), 'utf8'));
      assert.equal(saved.batches[0].status, 'completed');
    }
    return completion(idOf(call));
  });
  const result = await f.engine.batch({ title: 'Library listening', question: 'Describe the musical development.', items: [
    { label: 'A', sources: [{ path: f.audio }, { path: f.audio }] },
    { sources: [{ path: join(f.root, 'missing.wav') }] },
    ...Array.from({ length: 3 }, () => ({ sources: [{ path: f.audio }] })),
  ] });
  assert.equal(result.consultation.status, 'partial');
  assert.deepEqual(result.consultation.batches.map(b => b.itemIds), [['item-1'], ['item-3', 'item-4'], ['item-5']]);
  assert.match(result.consultation.items[1].error!, /ENOENT/);
  assert.equal(f.calls[0].body.messages[0].content.filter((p: any) => p.type === 'input_audio').length, 2);
  assert.match(idOf(f.calls[1]), /item-3, item-4/);
});

test('transient errors retry within each request deadline; fatal failures and cancellation preserve remaining work', async t => {
  const f = await fixture(t);
  await f.configure({ limits: { timeoutMs: 50, maxItemsPerRequest: 1 } });
  f.respond(async call => {
    if (f.calls.length === 1) {
      await writeFile(f.audio, 'changed after the batch was sent');
      await delay(1000, undefined, { signal: call.init.signal! }); return completion();
    }
    if (f.calls.length === 2) {
      await writeFile(f.audio, f.original);
      return new Response('', { status: 429, headers: { 'retry-after': '0' } });
    }
    if (f.calls.length === 4) return new Response('', { status: 401 });
    return completion();
  });
  const result = await f.engine.batch({ title: 'Three groups', question: 'Listen.', items: Array.from({ length: 3 }, () => ({ sources: [{ path: f.audio }] })) });
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[1].init.body, f.calls[0].init.body);
  assert.equal(f.calls[2].init.body, f.calls[0].init.body);
  assert.equal(result.consultation.status, 'partial');
  assert.equal(result.consultation.batches[0].attempts.length, 3);
  assert.match(result.consultation.batches[0].attempts[0].error!, /timed out/);
  assert.deepEqual(result.consultation.items.map(i => i.status), ['completed', 'failed', 'pending']);
  const controller = new AbortController();
  f.respond(async call => { controller.abort(); await delay(1000, undefined, { signal: call.init.signal! }); return completion(); });
  const cancelled = await f.engine.ask(f.request, { signal: controller.signal });
  assert.equal(cancelled.consultation.status, 'cancelled');
  assert.equal(f.calls.length, 5);
  assert.equal(JSON.parse(await readFile(cancelled.archive.recordPath, 'utf8')).status, 'cancelled');
  assert.deepEqual(await readdir(f.temporaryRoot), []);
});

test('archive failure returns the obtained answer and stops further submissions', async t => {
  const f = await fixture(t);
  await f.configure({ limits: { maxItemsPerRequest: 1 } });
  f.respond(async () => {
    const dir = join(f.root, '.media/audio-ask/records');
    const [entry] = await readdir(dir);
    await rm(join(dir, entry), { recursive: true });
    await writeFile(join(dir, entry), 'blocked');
    return completion();
  });
  const result = await f.engine.batch({ title: 'Save failure', question: 'Listen.', items: Array.from({ length: 2 }, () => ({ sources: [{ path: f.audio }] })) });
  assert.equal(f.calls.length, 1);
  assert.equal(result.consultation.status, 'partial');
  assert.match(result.consultation.batches[0].answer!, /bass/);
  assert.equal(result.archive.saved, false);
  assert.match(result.archive.error!, /Archive save failed/);
});

test('concurrent consultations share content identities and regenerate readable views from records', async t => {
  const f = await fixture(t);
  const copy = join(f.root, 'renamed.wav'); await writeFile(copy, f.original);
  const results = await Promise.all([f.engine.ask(f.request), f.engine.ask({ ...f.request, sources: [{ path: copy }] })]);
  assert.ok(results.every(r => r.archive.saved));
  const archive = join(f.root, '.media/audio-ask');
  assert.equal((await readdir(join(archive, 'assets'))).length, 1);
  await rm(join(archive, 'index.md'));
  await rm(results[0].archive.reportPath);
  await rebuildIndexes(archive);
  const index = await readFile(join(archive, 'index.md'), 'utf8');
  assert.ok(results.every(result => index.includes(result.consultation.id)));
  assert.match(await readFile(results[0].archive.reportPath, 'utf8'), /bass/);
});

test('legacy migration retains original analysis and configuration while collapsing linked batch copies', async t => {
  const f = await fixture(t);
  const existing = await f.engine.ask(f.request);
  await rm(join(f.root, '.pi/audio-ask.local.json'));
  await writeFile(join(f.root, '.pi/audio-understand.local.json'), JSON.stringify({ ...f.config, limits: { timeoutMs: 1234, cacheMaxAgeMs: 1 } }));
  const old = join(f.root, '.cache/audio-understand'); await mkdir(old, { recursive: true });
  const child = 'a'.repeat(64), parent = 'b'.repeat(64);
  const source = JSON.parse(JSON.stringify(existing.consultation.items[0].prepared[0]));
  delete source.submitted.start; delete source.submitted.end;
  const value = { createdAt: existing.consultation.createdAt, question: 'Historical instrument analysis ' + '渐强'.repeat(60), sources: [source], model: 'old-model', endpoint: 'https://old.invalid', answer: 'Old piano observation.', usage: null, warnings: [] };
  await writeFile(join(old, `${child}.json`), JSON.stringify({ key: child, result: value }));
  await writeFile(join(old, `${parent}.json`), JSON.stringify({ key: parent, result: { ...value, batches: [{ id: 'batch-1', sourceIds: [source.id], status: 'completed', answer: value.answer, cache: { key: child } }] } }));
  const migrated = await migrateLegacy(f.root);
  assert.equal(migrated.configMigrated, true);
  assert.equal(migrated.imported, 1);
  assert.equal(migrated.linkedBatchFiles, 1);
  assert.deepEqual(migrated.issues, []);
  const config = JSON.parse(await readFile(join(f.root, '.pi/audio-ask.local.json'), 'utf8'));
  assert.equal(config.apiKey, f.config.apiKey);
  assert.equal(config.api, 'openai-completions');
  assert.equal(config.audioDataFormat, 'data-url');
  assert.equal(config.limits.timeoutMs, 1234);
  assert.equal(config.limits.cacheMaxAgeMs, undefined);
  assert.equal((await readdir(old)).length, 2);
  assert.equal((await migrateLegacy(f.root)).alreadyImported, 1);
  const index = await readFile(join(f.root, '.media/audio-ask/index.md'), 'utf8');
  assert.match(index, /Historical instrument analysis/);
  const [directory] = (await readdir(join(f.root, '.media/audio-ask/records'))).filter(name => name.includes('-legacy-'));
  const imported = JSON.parse(await readFile(join(f.root, '.media/audio-ask/records', directory, 'record.json'), 'utf8'));
  assert.equal(imported.items[0].prepared[0].timeMapping, 'legacy-estimate');
  assert.match(imported.batches[0].answer, /Old piano observation/);
});

test('MP3 cuts preserve encoded packets and map audible samples to source time; PCM keeps source precision', async t => {
  const f = await fixture(t);
  const mp3 = join(f.root, 'original.mp3');
  execFileSync('ffmpeg', ['-v', 'error', '-i', f.audio, '-c:a', 'libmp3lame', '-b:a', '64k', mp3]);
  const result = await f.engine.ask({ ...f.request, sources: [{ path: mp3, start: 1.013, end: 2.017 }] });
  const source = result.consultation.items[0].prepared[0];
  assert.equal(result.consultation.status, 'completed');
  assert.ok(source.submitted.start <= 1.013 && source.submitted.end >= 2.017);
  const submitted = f.calls[0].body.messages[0].content.find((p: any) => p.type === 'input_audio');
  const clip = join(f.root, 'submitted.mp3'); await writeFile(clip, Buffer.from(submitted.input_audio.data.split(',')[1], 'base64'));
  const packets = (file: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_packets', '-show_entries', 'packet=data_hash', '-show_data_hash', 'sha256', '-of', 'json', file], { encoding: 'utf8' })).packets.map((p: any) => p.data_hash);
  const original = packets(mp3), copied = packets(clip);
  const offset = original.indexOf(copied[0]);
  assert.ok(offset >= 0); assert.deepEqual(copied, original.slice(offset, offset + copied.length));
  const decode = (file: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '8000', 'pipe:1']);
  const from = Math.round((1.013 - source.submitted.start) * 8000), at = Math.round(source.submitted.start * 8000) + from;
  assert.deepEqual(decode(clip).subarray(from * 2, (from + 2000) * 2), decode(mp3).subarray(at * 2, (at + 2000) * 2));
  const wav = join(f.root, '24bit.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-i', f.audio, '-c:a', 'pcm_s24le', wav]);
  await f.engine.ask({ ...f.request, sources: [{ path: wav, start: 1, end: 2 }] });
  const data = f.calls[1].body.messages[0].content.find((p: any) => p.type === 'input_audio');
  const converted = join(f.root, 'submitted.wav'); await writeFile(converted, Buffer.from(data.input_audio.data.split(',')[1], 'base64'));
  assert.equal(pcm(await readFile(converted)).length, 8000 * 3);
  assert.deepEqual(pcm(await readFile(converted)), pcm(await readFile(wav)).subarray(8000 * 3, 16000 * 3));
});

test('Pi tools execute against a local HTTP endpoint and preserve structured results and readable answers', async t => {
  const f = await fixture(t);
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/v1/responses') {
      requests.push(body);
      res.setHeader('content-type', 'application/json');
      if (body.input === 'Expired branch') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'response_not_found', param: 'previous_response_id', message: 'Saved response expired: test-secret' } }));
        return;
      }
      if (body.input === 'Incomplete branch') {
        res.end(JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }));
        return;
      }
      res.end(JSON.stringify({ id: `resp-${requests.length}`, status: 'completed', model: 'resolved-responses', output: [
        { type: 'reasoning', summary: [] },
        { type: 'message', content: [{ type: 'output_text', text: 'A clear piano entry.' }] },
      ], usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 } }));
      return;
    }
    assert.equal(body.messages[0].content.at(-1).text, f.request.question);
    if (req.url === '/redirect/chat/completions') { res.writeHead(307, { location: '/v1/chat/completions' }); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(await completion().text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number };
  await f.configure({ baseUrl: `http://127.0.0.1:${address.port}/v1` });
  const [ask, batch] = createTools(f.root);
  const context = { cwd: f.root, isProjectTrusted: () => true };
  const result = await ask.execute('one', f.request, undefined, undefined, context);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /darker pulse/);
  const many = await batch.execute('many', { title: f.request.title, question: f.request.question, items: [{ sources: f.request.sources }] }, undefined, undefined, context);
  assert.equal(many.structuredContent.consultation.mode, 'batch');
  await f.configure({ api: 'openai-responses', audioDataFormat: 'data-url', requestParams: { max_output_tokens: 512 } });
  const responses = await ask.execute('responses', f.request, undefined, undefined, context);
  assert.equal(responses.isError, false);
  assert.match(responses.content[0].text, /A clear piano entry/);
  assert.equal(responses.structuredContent.consultation.batches[0].usage?.inputTokens, 30);
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].max_output_tokens, 512);
  assert.deepEqual(requests[0].input[0].content.at(-1), { type: 'input_text', text: f.request.question });
  assert.deepEqual(requests[0].input[0].content.find((part: any) => part.type === 'input_audio'), {
    type: 'input_audio', data: `data:audio/wav;base64,${f.original.toString('base64')}`, format: 'wav',
  });

  const parent = await ask.execute('parent', { ...f.request, allowContinuation: true }, undefined, undefined, context);
  assert.equal(requests[1].store, true);
  const parentPath = parent.structuredContent.archive.recordPath;
  const originalRecord = await readFile(parentPath, 'utf8');
  const originalItems = JSON.parse(originalRecord).items;
  await rm(f.audio); // Follow-ups depend on the archived context, not the local file.
  const follow = (question: string, continueFrom = parentPath, allowContinuation?: boolean) => ask.execute(
    'follow', { title: 'Piano detail', question, continueFrom, allowContinuation }, undefined, undefined, context,
  );
  const child = await follow('When does the piano enter?');
  assert.equal(child.isError, false);
  assert.deepEqual(requests[2], {
    model: 'test-audio', max_output_tokens: 512, stream: false, store: true,
    input: 'When does the piano enter?', previous_response_id: 'resp-2',
  });
  const childRecord = child.structuredContent.consultation;
  assert.equal(childRecord.continuation?.id, parent.structuredContent.consultation.id);
  assert.deepEqual(childRecord.items[0].prepared, originalItems[0].prepared);
  assert.equal(childRecord.batches[0].encodedAudioBytes, 0);
  assert.match(await readFile(child.structuredContent.archive.reportPath, 'utf8'), /Continues .*report\.md/);
  const last = await follow('Compare the phrase endings.', child.structuredContent.archive.recordPath, false);
  assert.equal(last.isError, false);
  assert.equal(requests[3].previous_response_id, 'resp-3');
  assert.equal(requests[3].store, false);
  await assert.rejects(follow('One more detail', last.structuredContent.archive.recordPath), /saved for continuation/);
  await f.configure({ model: 'another-model' });
  await assert.rejects(follow('Other model'), /original endpoint and model/);
  await f.configure({ model: 'test-audio' });
  assert.equal(requests.length, 4);
  const expired = await follow('Expired branch');
  assert.equal(expired.isError, true);
  assert.match(expired.content[0].text, /response_not_found.*previous_response_id.*Saved response expired/);
  assert.equal(expired.content[0].text.includes('test-secret'), false);
  assert.deepEqual(expired.structuredContent.consultation.items[0].prepared, originalItems[0].prepared);
  assert.equal(requests[4].previous_response_id, 'resp-2');
  const incomplete = await follow('Incomplete branch');
  assert.match(incomplete.content[0].text, /incomplete.*max_output_tokens/);
  assert.equal(requests.length, 6);
  assert.equal(await readFile(parentPath, 'utf8'), originalRecord);
  await writeFile(f.audio, f.original);
  await f.configure({ api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/redirect`, requestParams: {} });
  assert.equal((await ask.execute('redirect', f.request, undefined, undefined, context)).isError, true);
});
