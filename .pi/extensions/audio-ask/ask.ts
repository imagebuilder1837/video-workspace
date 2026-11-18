import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig, isObject } from './config.ts';
import { requestAudioBatch, type PreparedItem } from './audio-api.ts';
import { inspectSource, prepareSource } from './media.ts';
import { readConsultation, saveRecord } from './archive.ts';
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
    const progress = (text: string) => { options.onProgress?.(text); signal.throwIfAborted(); };
    const checkpoint = () => {
      record.updatedAt = new Date().toISOString();
      return saveRecord(archiveRoot, structuredClone(record));
    };
    // Coalesce answers that arrive while the archive is being written.
    let backup: Promise<void> | undefined;
    let backupPending = false;
    const backUp = () => {
      backupPending = true;
      backup ??= (async () => {
        try {
          while (backupPending) {
            backupPending = false;
            await checkpoint();
          }
        } finally { backup = undefined; }
      })();
    };
    const inFlight = new Set<Promise<void>>();
    let stopped = false;
    const { maxConcurrentRequests, maxItemsPerRequest, maxEncodedAudioBytes } = config.limits;
    const waitForSlot = async () => {
      if (!stopped && maxConcurrentRequests && inFlight.size >= maxConcurrentRequests) await Promise.race(inFlight);
      signal.throwIfAborted();
    };
    let scratch: string | undefined;
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
        const response = await requestAudioBatch(config, key, {
          items: group, question: request.question, continuation: { store, previousResponseId }, signal, fetch: dependencies.fetch,
          onProgress: phase => progress('retryAfterMs' in phase
            ? `${entry.id}: retry in ${phase.retryAfterMs} ms`
            : `${entry.id}: request ${phase.number}/${phase.maxAttempts} (${itemIds.join(', ')})`),
        });
        Object.assign(entry, response);
        if (response.status === 'completed') {
          for (const item of items) item.status = 'completed';
          if (store && !response.requestId) record.warnings.push('The service returned no response ID for continuation.');
        } else {
          stopped = true;
          for (const item of items) { item.status = 'failed'; item.error = response.error; }
        }
        if (batch) backUp();
      } finally {
        for (const item of group) await cleanup(item.directory);
      }
    };
    try {
      if (parent) {
        await requestGroups(record.items.map(item => item.id), []);
      } else {
        scratch = await mkdtemp(join(dependencies.temporaryRoot ?? tmpdir(), 'pi-audio-ask-'));
        let pending: PreparedGroup[] = [];
        const dispatch = async () => {
          if (!pending.length) return;
          await waitForSlot();
          if (stopped) return;
          const group = pending;
          pending = [];
          const task = requestGroups(group.map(item => item.id), group).finally(() => inFlight.delete(task));
          inFlight.add(task);
        };
        for (const [index, item] of record.items.entries()) {
          await waitForSlot();
          if (stopped) break;
          progress(`Preparing ${item.id} (${index + 1}/${record.items.length})`);
          const directory = join(scratch, item.id);
          await mkdir(directory);
          let prepared: PreparedGroup;
          try {
            prepared = await prepareItem(item, directory, maxEncodedAudioBytes, cwd, signal);
          } catch (error) {
            signal.throwIfAborted();
            item.status = 'failed'; item.error = error instanceof Error ? error.message : String(error);
            await cleanup(directory);
            continue;
          }
          const bytes = pending.reduce((sum, p) => sum + p.bytes, 0);
          if (pending.length && bytes + prepared.bytes > maxEncodedAudioBytes) await dispatch();
          if (stopped) break;
          pending.push(prepared);
          if (maxItemsPerRequest && pending.length >= maxItemsPerRequest) await dispatch();
        }
        if (!stopped) await dispatch();
      }
    } catch (error) {
      if (!signal.aborted) record.warnings.push(error instanceof Error ? error.message : String(error));
    } finally {
      await Promise.all(inFlight);
      if (scratch) await cleanup(scratch);
    }
    const completed = record.items.filter(item => item.status === 'completed').length;
    record.status = signal.aborted ? 'cancelled' : completed === record.items.length ? 'completed' : completed ? 'partial' : 'failed';
    backupPending = false;
    await backup;
    return { consultation: record, archive: await checkpoint() };
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
