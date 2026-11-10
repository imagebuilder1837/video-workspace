import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isObject } from './config.ts';
import type { ModelAnswer } from './chat-completions.ts';
import type { SourceRecord } from './media.ts';

export type SavedAnalysis = ModelAnswer & {
  question: string; createdAt: string; endpoint: string; model: string;
  sources: SourceRecord[]; warnings: string[];
};

export function requestKey(value: unknown): string {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable);
    if (isObject(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, stable(item[key])]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function reportPath(workspaceRoot: string, key: string): string {
  return join(workspaceRoot, '.cache', 'audio-understand', `${key}.json`);
}

export async function readCache(path: string, key: string, maxAgeMs: number, signal: AbortSignal): Promise<SavedAnalysis | null> {
  if (maxAgeMs === 0) return null;
  signal.throwIfAborted();
  try {
    if ((await stat(path)).size > 4 * 1024 * 1024) return null;
    const entry = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
    if (!isObject(entry) || entry.version !== 1 || entry.key !== key || !isObject(entry.result)) return null;
    const result = entry.result;
    const age = Date.now() - Date.parse(String(result.createdAt));
    if (!Number.isFinite(age) || age < 0 || age >= maxAgeMs || typeof result.answer !== 'string' || !result.answer.trim()
      || typeof result.question !== 'string' || typeof result.endpoint !== 'string' || typeof result.model !== 'string'
      || !Array.isArray(result.sources) || !result.sources.length || !Array.isArray(result.warnings)
      || result.warnings.some((warning: unknown) => typeof warning !== 'string')
      || (result.usage !== null && !isObject(result.usage))
      || result.sources.some((source: unknown) => !isObject(source) || typeof source.id !== 'string'
        || typeof source.path !== 'string' || typeof source.sha256 !== 'string'
        || typeof source.start !== 'number' || typeof source.end !== 'number' || !isObject(source.submitted))) return null;
    return result as SavedAnalysis;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SyntaxError || (error as { code?: string }).code === 'ENOENT') return null;
    throw new Error('Audio result cache could not be read; check local cache permissions.');
  }
}

export async function writeCache(path: string, key: string, result: SavedAnalysis, signal: AbortSignal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify({ version: 1, key, result }, null, 2), { mode: 0o600, signal });
    signal.throwIfAborted();
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
