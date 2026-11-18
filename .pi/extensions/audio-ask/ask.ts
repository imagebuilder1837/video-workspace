import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, isObject } from './config.ts';
import type { AudioConfig } from './config.ts';
import { prepareAudioRequest, AudioServiceError, type PreparedItem } from './audio-api.ts';
import { inspectSource, prepareSource } from './media.ts';
import { archivePaths, readConsultation, saveRecord } from './archive.ts';
import type { AskRequest, AskResult, AudioItem, BatchRequest, BatchRecord, Consultation, ItemRecord } from './types.ts';

export type CallOptions = { cwd?: string; signal?: AbortSignal; onProgress?: (phase: string) => void };
type PreparedGroup = PreparedItem & { directory: string; bytes: number };

function validate(request: AskRequest | BatchRequest, batch: boolean): AudioItem[] {
  for (const key of ['title', 'question'] as const) {
    if (typeof request?.[key] !== 'string' || !request[key].trim() || request[key].length > (key === 'title' ? 200 : 65536)) {
      throw new Error(`Provide a nonempty ${key} of at most ${key === 'title' ? 200 : 65536} characters.`);
    }
  }
  const { continueFrom, allowContinuation, sources } = request as AskRequest;
  if (allowContinuation !== undefined && (batch || typeof allowContinuation !== 'boolean')) {
    throw new Error('Use a boolean allowContinuation with audio_ask.');
  }
  if (continueFrom !== undefined) {
    if (batch || sources !== undefined || typeof continueFrom !== 'string' || !continueFrom.trim()) {
      throw new Error('For a text-only follow-up, supply continueFrom in place of sources to audio_ask.');
    }
    return [];
  }
  const items = batch ? (request as BatchRequest).items : [{ sources: sources ?? [] }];
  if (!Array.isArray(items) || !items.length) throw new Error('Provide audio items.');
  for (const item of items) {
    if (!isObject(item) || !Array.isArray(item.sources) || !item.sources.length) throw new Error('Each item requires audio sources.');
    if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 500)) throw new Error('Labels accept up to 500 characters.');
    for (const source of item.sources) {
      if (!isObject(source) || typeof source.path !== 'string' || !source.path.trim()) throw new Error('Each source requires a path.');
      if (source.label !== undefined && (typeof source.label !== 'string' || source.label.length > 500)) throw new Error('Labels accept up to 500 characters.');
      for (const key of ['start', 'end'] as const) if (source[key] !== undefined && !Number.isFinite(source[key])) throw new Error('Source times must be finite numbers.');
    }
  }
  return items;
}

export function createAudioAsk(
  workspaceRoot: string,
  dependencies: { fetch?: typeof fetch; env?: Record<string, string | undefined>; temporaryRoot?: string } = {},
) {
  const archiveRoot = join(resolve(workspaceRoot), '.media', 'audio-ask');
  async function run(request: AskRequest | BatchRequest, batch: boolean, options: CallOptions): Promise<AskResult> {
    const input = validate(request, batch);
    const config = await loadConfig(workspaceRoot);
    const key = config.apiKey || (config.apiKeyEnv ? (dependencies.env ?? process.env)[config.apiKeyEnv]?.trim() : undefined);
    if (!key || /[\r\n]/.test(key)) throw new Error(`Configure a single-line API key${config.apiKeyEnv ? ` through ${config.apiKeyEnv}` : ''}.`);
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const cwd = options.cwd ?? workspaceRoot;
    const { continueFrom, allowContinuation } = request as AskRequest;
    const store = allowContinuation ?? (continueFrom !== undefined);
    if ((store || continueFrom) && config.api !== 'openai-responses') {
      throw new Error('Audio continuation requires api: openai-responses.');
    }
    const parent = continueFrom ? await readConsultation(archiveRoot, resolve(cwd, continueFrom)) : undefined;
    let previousResponseId: string | undefined;
    if (parent) {
      const previous = parent.record;
      if (previous.endpoint !== config.baseUrl || previous.model !== config.model || previous.api !== config.api) {
        throw new Error('Use the original endpoint and model to continue this consultation.');
      }
      const batch = previous.batches[0];
      previousResponseId = batch?.requestId;
      if (previous.mode !== 'ask' || previous.status !== 'completed' || !previous.allowContinuation
        || previous.batches.length !== 1 || batch.status !== 'completed' || typeof previousResponseId !== 'string' || !previousResponseId.trim()) {
        throw new Error('Choose a completed consultation saved for continuation.');
      }
    }
    const createdAt = new Date().toISOString();
    const record: Consultation = {
      version: 1, id: `${createdAt.replace(/[-:.]/g, '')}-${randomUUID()}`, title: request.title, question: request.question,
      mode: batch ? 'batch' : 'ask', createdAt, updatedAt: createdAt, status: 'running',
      endpoint: config.baseUrl, model: config.model, api: config.api,
      requestParams: JSON.parse(JSON.stringify(config.requestParams, (_name, value) =>
        typeof value === 'string' ? value.replaceAll(key, '[redacted credential]') : value)),
      items: parent ? parent.record.items.map(item => ({ ...item, status: 'ready', error: undefined }))
        : input.map((item, i) => ({ ...item, id: `item-${i + 1}`, status: 'pending', prepared: [] })),
      batches: [], warnings: [],
      ...(store ? { allowContinuation: true } : {}),
      ...(parent ? { continuation: { id: parent.record.id, recordPath: parent.recordPath } } : {}),
    };
    const result: AskResult = { consultation: record, archive: archivePaths(archiveRoot, record) };
    const progress = (text: string) => { options.onProgress?.(text); signal.throwIfAborted(); };
    const persist = async () => {
      record.updatedAt = new Date().toISOString();
      try { result.archive = await saveRecord(archiveRoot, record); return true; } catch (error) {
        result.archive.saved = false;
        result.archive.error = `Archive save failed: ${error instanceof Error ? error.message : String(error)}`;
        return false;
      }
    };
    // Check archive access before starting paid work; each batch then checkpoints its answer.
    if (!await persist()) { record.status = 'failed'; return result; }
    let scratch: string | undefined;
    let stopped = false;
    let pending: PreparedGroup[] = [];
    const cleanup = async (directory: string) => {
      try { await rm(directory, { recursive: true, force: true }); } catch (error) {
        record.warnings.push(`Temporary audio cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const requestGroups = async (itemIds: string[], group: PreparedGroup[]) => {
      const entry: BatchRecord = {
        id: `batch-${record.batches.length + 1}`, itemIds,
        encodedAudioBytes: group.reduce((sum, item) => sum + item.bytes, 0), status: 'running', attempts: [],
      };
      record.batches.push(entry);
      const items = record.items.filter(item => itemIds.includes(item.id));
      try {
        const send = await prepareAudioRequest(config, key, group, request.question, { store, previousResponseId }, signal, dependencies.fetch);
        await requestBatch(config, send, entry, signal, progress);
        for (const item of items) item.status = 'completed';
        if (store && !entry.requestId) record.warnings.push('The service returned no response ID for continuation.');
      } catch (error) {
        entry.status = 'failed';
        entry.error = signal.aborted ? 'Cancelled.' : error instanceof Error ? error.message : String(error);
        for (const item of items) { item.status = 'failed'; item.error = entry.error; }
      } finally {
        for (const item of group) await cleanup(item.directory);
      }
      const saved = await persist();
      return saved && entry.status === 'completed';
    };
    try {
      if (parent) {
        await requestGroups(record.items.map(item => item.id), []);
      } else {
        scratch = await mkdtemp(join(dependencies.temporaryRoot ?? tmpdir(), 'pi-audio-ask-'));
        const dispatch = async () => {
          if (!pending.length) return true;
          const group = pending;
          pending = [];
          return requestGroups(group.map(item => item.id), group);
        };
        for (const [index, item] of record.items.entries()) {
          progress(`Preparing ${item.id} (${index + 1}/${record.items.length})`);
          const directory = join(scratch, item.id);
          await mkdir(directory);
          let prepared: PreparedGroup;
          try {
            prepared = await prepareItem(item, directory, config.limits.maxEncodedAudioBytes, cwd, signal);
          } catch (error) {
            signal.throwIfAborted();
            item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error);
            await cleanup(directory);
            if (!await persist()) { stopped = true; break; }
            continue;
          }
          const bytes = pending.reduce((sum, p) => sum + p.bytes, 0);
          if (pending.length && bytes + prepared.bytes > config.limits.maxEncodedAudioBytes) {
            if (!await dispatch()) { stopped = true; break; }
          }
          pending.push(prepared);
          if (pending.length >= config.limits.maxItemsPerRequest && !await dispatch()) { stopped = true; break; }
        }
        if (!stopped) await dispatch();
      }
    } catch (error) {
      if (!signal.aborted) record.warnings.push(error instanceof Error ? error.message : String(error));
    } finally {
      if (scratch) await cleanup(scratch);
    }
    const completed = record.items.filter(item => item.status === 'completed').length;
    record.status = signal.aborted ? 'cancelled' : completed === record.items.length ? 'completed' : completed ? 'partial' : 'failed';
    // Ready means prepared but unsent; preserve this distinction when a preceding batch stops the run.
    if (!result.archive.error) await persist();
    return result;
  }
  return {
    ask: (request: AskRequest, options: CallOptions = {}) => run(request, false, options),
    batch: (request: BatchRequest, options: CallOptions = {}) => run(request, true, options),
  };
}

async function prepareItem(item: ItemRecord, directory: string, limit: number, cwd: string, signal: AbortSignal): Promise<PreparedGroup> {
  const sources = [];
  let bytes = 0;
  for (const [i, source] of item.sources.entries()) {
    const inspected = await inspectSource(source, cwd, signal);
    const prepared = await prepareSource(inspected, i, directory, limit, signal);
    prepared.record.id = `${item.id}/source-${i + 1}`;
    prepared.record.label = source.label;
    item.prepared.push(prepared.record);
    sources.push(prepared);
    bytes += 4 * Math.ceil(prepared.record.submitted.bytes / 3);
    if (bytes > limit) throw new Error(`${item.id} needs ${bytes} Base64 audio bytes; maxEncodedAudioBytes is ${limit}. Select shorter ranges.`);
  }
  item.status = 'ready';
  return { id: item.id, label: item.label, sources, directory, bytes };
}

async function requestBatch(
  config: AudioConfig, send: Awaited<ReturnType<typeof prepareAudioRequest>>, entry: BatchRecord,
  signal: AbortSignal, progress: (text: string) => void,
) {
  for (let number = 1; number <= config.retry.maxAttempts; number++) {
    signal.throwIfAborted();
    const attempt: BatchRecord['attempts'][number] = { number, startedAt: new Date().toISOString() };
    entry.attempts.push(attempt);
    const deadline = AbortSignal.timeout(config.limits.timeoutMs);
    const bounded = AbortSignal.any([signal, deadline]);
    try {
      progress(`${entry.id}: request ${number}/${config.retry.maxAttempts} (${entry.itemIds.join(', ')})`);
      Object.assign(entry, await send(bounded), { status: 'completed' });
      return;
    } catch (error) {
      attempt.error = signal.aborted ? 'Cancelled.' : deadline.aborted ? 'Audio request timed out.' : error instanceof Error ? error.message : String(error);
      const retryable = deadline.aborted || (error instanceof AudioServiceError && error.retryable);
      if (signal.aborted || !retryable || number === config.retry.maxAttempts) throw new Error(attempt.error);
      const wait = error instanceof AudioServiceError && error.retryAfterMs !== undefined
        ? error.retryAfterMs : config.retry.baseDelayMs * 2 ** (number - 1);
      attempt.retryAfterMs = Math.min(wait, 2147483647);
      progress(`${entry.id}: retry in ${attempt.retryAfterMs} ms`);
      await delay(attempt.retryAfterMs, undefined, { signal });
    }
  }
}
