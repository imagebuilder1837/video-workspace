import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { askAudio } from './chat-completions.ts';
import { readCache, reportPath, requestKey, writeCache } from './cache.ts';
import type { SavedAnalysis } from './cache.ts';
import { inspectSource, prepareSource } from './media.ts';
import type { AudioSource, PreparedSource } from './media.ts';

export type AudioQuestion = { sources: AudioSource[]; question: string };
export type AudioResult = SavedAnalysis & { cache: { hit: boolean; key: string; reportPath: string | null } };
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
    let scratch: string | undefined;
    let remoteStarted = false;
    try {
      progress('Inspecting local audio');
      const sources = [];
      for (const source of request.sources) sources.push(await inspectSource(source, options.cwd ?? root, signal));
      const key = requestKey({ version: 1, sources, question: request.question, baseUrl: config.baseUrl, model: config.model, requestParams: config.requestParams, apiKeyEnv: config.apiKeyEnv });
      const path = reportPath(root, key);
      const cached = await readCache(path, key, config.limits.cacheMaxAgeMs, signal);
      if (cached) {
        progress('Reusing local answer');
        return { ...cached, cache: { hit: true, key, reportPath: path } };
      }
      const apiKey = config.apiKey || (config.apiKeyEnv ? (dependencies.env ?? process.env)[config.apiKeyEnv]?.trim() : undefined);
      if (!apiKey) throw new Error(`Set ${config.apiKeyEnv} in the environment of the process running pi.`);
      if (/[\r\n]/.test(apiKey)) throw new Error('The configured API key must be a single line.');
      progress('Preparing audio');
      scratch = await mkdtemp(join(dependencies.temporaryRoot ?? tmpdir(), 'pi-audio-understand-'));
      const prepared: PreparedSource[] = [];
      let encodedBytes = 0;
      for (const [index, source] of sources.entries()) {
        const item = await prepareSource(source, index, scratch, config.limits.maxEncodedAudioBytes - encodedBytes, signal);
        encodedBytes += 4 * Math.ceil(item.data.length / 3);
        if (encodedBytes > config.limits.maxEncodedAudioBytes) throw new Error('Prepared audio exceeds maxEncodedAudioBytes; select shorter ranges.');
        prepared.push(item);
      }
      progress('Sending audio and question to the configured service');
      remoteStarted = true;
      const answer = await askAudio(config, apiKey, prepared, request.question, signal, dependencies.fetch);
      signal.throwIfAborted();
      const result: SavedAnalysis = {
        ...answer, question: request.question, createdAt: new Date().toISOString(),
        endpoint: config.baseUrl, model: config.model, sources: prepared.map((source) => source.record),
        warnings: ['Model descriptions and timestamps are estimates. Each source records its clip-to-source offset; verify the time basis of the answer.'],
      };
      progress('Saving answer locally');
      let savedPath: string | null = path;
      try { await writeCache(path, key, result, signal); } catch {
        signal.throwIfAborted();
        savedPath = null;
        result.warnings.push('The answer succeeded but its local report could not be saved; check cache permissions.');
      }
      return { ...result, cache: { hit: false, key, reportPath: savedPath } };
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`Audio understanding ${deadline.aborted && !options.signal?.aborted ? 'timed out' : 'was cancelled'}.${remoteStarted ? ' The service may already have processed and charged the request.' : ''}`);
      }
      throw error;
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  };
}
