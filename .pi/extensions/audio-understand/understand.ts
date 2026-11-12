import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { askAudio } from './chat-completions.ts';
import type { ModelAnswer, TokenUsage } from './chat-completions.ts';
import { readCache, reportPath, requestKey, writeCache } from './cache.ts';
import type { SavedAnalysis } from './cache.ts';
import { inspectSource, prepareSource } from './media.ts';
import type { AudioSource, PreparedSource } from './media.ts';

export type AudioQuestion = { sources: AudioSource[]; question: string };
type CacheRecord = { hit: boolean; key: string; reportPath: string | null };
export type AudioBatch = Partial<ModelAnswer> & {
  id: string; sourceIds: string[]; encodedAudioBytes: number;
  status: 'completed' | 'failed' | 'not_sent'; cache?: CacheRecord; error?: string;
};
export type AudioResult = SavedAnalysis & {
  status: 'completed' | 'partial' | 'failed'; batches: AudioBatch[]; cache: CacheRecord;
};
export type CallOptions = { cwd?: string; signal?: AbortSignal; onProgress?: (phase: string) => void };

export function createAudioUnderstanding(
  workspaceRoot: string,
  dependencies: { fetch?: typeof fetch; env?: Record<string, string | undefined>; temporaryRoot?: string } = {},
) {
  const root = resolve(workspaceRoot);
  return async function understand(request: AudioQuestion, options: CallOptions = {}): Promise<AudioResult> {
    options.signal?.throwIfAborted();
    if (!request || typeof request.question !== 'string' || !request.question.trim() || request.question.length > 65536) {
      throw new Error('Provide a nonempty question of at most 65536 characters.');
    }
    if (!Array.isArray(request.sources) || request.sources.length < 1 || request.sources.length > 250) {
      throw new Error('Provide between 1 and 250 local audio sources.');
    }
    const config = await loadConfig(root);
    const deadline = AbortSignal.timeout(config.limits.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const progress = (phase: string) => { signal.throwIfAborted(); options.onProgress?.(phase); };
    const failureMessage = (error: unknown, sent: boolean) => signal.aborted
      ? `Audio understanding ${deadline.aborted && !options.signal?.aborted ? 'timed out' : 'was cancelled'}.${sent ? ' The service may already have processed and charged the request.' : ''}`
      : error instanceof Error ? error.message : 'Audio understanding failed.';
    const warnings = ['Model descriptions and timestamps are estimates. Use submitted.start as the clip-to-source offset.'];
    let scratch: string | undefined;
    try {
      progress('Inspecting local audio');
      const sources = [];
      for (const source of request.sources) sources.push(await inspectSource(source, options.cwd ?? root, signal));
      progress('Preparing and checking all audio before upload');
      scratch = await mkdtemp(join(dependencies.temporaryRoot ?? tmpdir(), 'pi-audio-understand-'));
      const prepared: PreparedSource[] = [];
      for (const [index, source] of sources.entries()) {
        prepared.push(await prepareSource(source, index, scratch, config.limits.maxEncodedAudioBytes, signal));
      }
      const groups: PreparedSource[][] = [];
      const batches: AudioBatch[] = [];
      for (const source of prepared) {
        const bytes = 4 * Math.ceil(source.record.submitted.bytes / 3);
        let batch = batches.at(-1);
        if (!batch || batch.encodedAudioBytes + bytes > config.limits.maxEncodedAudioBytes) {
          batch = { id: `batch-${batches.length + 1}`, sourceIds: [], encodedAudioBytes: 0, status: 'not_sent' };
          batches.push(batch);
          groups.push([]);
        }
        batch.sourceIds.push(source.record.id);
        batch.encodedAudioBytes += bytes;
        groups.at(-1)!.push(source);
      }
      const keys = groups.map(group => requestKey({
        version: 2, sources: group.map(source => source.record), question: request.question,
        baseUrl: config.baseUrl, model: config.model, requestParams: config.requestParams, apiKeyEnv: config.apiKeyEnv,
      }));
      for (const [index, group] of groups.entries()) {
        const batch = batches[index];
        let sent = false;
        try {
          progress(`Checking ${batch.id} of ${batches.length}`);
          const key = keys[index];
          const path = reportPath(root, key);
          const cached = await readCache(path, key, config.limits.cacheMaxAgeMs, signal);
          let analysis = cached;
          let savedPath: string | null = path;
          if (!analysis) {
            const apiKey = config.apiKey || (config.apiKeyEnv ? (dependencies.env ?? process.env)[config.apiKeyEnv]?.trim() : undefined);
            if (!apiKey) throw new Error(`Set ${config.apiKeyEnv} in the environment of the process running pi.`);
            if (/[\r\n]/.test(apiKey)) throw new Error('The configured API key must be a single line.');
            progress(`Sending ${batch.id} of ${batches.length}: ${batch.sourceIds.join(', ')}`);
            sent = true;
            const answer = await askAudio(config, apiKey, group, request.question, signal, dependencies.fetch);
            analysis = {
              ...answer, question: request.question, createdAt: new Date().toISOString(),
              endpoint: config.baseUrl, model: config.model, sources: group.map(source => source.record), warnings: [...warnings],
            };
            try { await writeCache(path, key, analysis, new AbortController().signal); } catch {
              savedPath = null;
              warnings.push(`${batch.id} succeeded; its local cache could not be saved.`);
            }
          }
          Object.assign(batch, {
            status: 'completed', answer: analysis.answer, usage: analysis.usage,
            responseModel: analysis.responseModel, requestId: analysis.requestId,
            cache: { hit: Boolean(cached), key, reportPath: savedPath },
          });
        } catch (error) {
          batch.status = 'failed';
          batch.error = failureMessage(error, sent);
          break;
        }
      }
      const completed = batches.filter(batch => batch.status === 'completed');
      const usage: TokenUsage = {};
      for (const batch of completed) {
        for (const [field, count] of Object.entries(batch.usage ?? {})) {
          const name = field as keyof TokenUsage;
          usage[name] = (usage[name] ?? 0) + count;
        }
      }
      const key = requestKey({ version: 2, batches: keys });
      const path = reportPath(root, key);
      const result: AudioResult = {
        status: completed.length === batches.length ? 'completed' : completed.length ? 'partial' : 'failed',
        answer: batches.length === 1 ? batches[0].answer ?? '' : batches.map(batch =>
          `${batch.id} (${batch.sourceIds.join(', ')}): ${batch.status}\n${batch.answer ?? batch.error ?? ''}`).join('\n\n'),
        question: request.question, createdAt: new Date().toISOString(), endpoint: config.baseUrl, model: config.model,
        responseModel: batches.length === 1 ? batches[0].responseModel : undefined,
        requestId: batches.length === 1 ? batches[0].requestId : undefined,
        usage: Object.keys(usage).length ? usage : null, sources: prepared.map(source => source.record), batches,
        warnings, cache: { hit: completed.length === batches.length && batches.every(batch => batch.cache?.hit), key, reportPath: path },
      };
      if (batches.length > 1) warnings.push('Each batch answer covers its listed sources; cross-batch comparisons require separate assessment.');
      if (completed.some(batch => batch.cache?.hit)) warnings.push('Cached batch usage belongs to the original requests.');
      // Persist partial coverage even when the call deadline or caller signal has expired.
      try { await writeCache(path, key, result, new AbortController().signal); } catch {
        result.cache.reportPath = null;
        warnings.push('The local report could not be saved; check cache permissions.');
      }
      return result;
    } catch (error) {
      throw new Error(failureMessage(error, false));
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  };
}
