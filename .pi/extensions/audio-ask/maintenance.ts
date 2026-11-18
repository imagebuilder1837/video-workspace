import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { archivePaths, rebuildIndexes, saveRecord } from './archive.ts';
import { isObject } from './config.ts';
import type { SourceRecord } from './media.ts';
import type { BatchRecord, Consultation, ItemRecord } from './types.ts';

async function exists(path: string) {
  try { await access(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function migrateLegacy(root: string) {
  const report = { configMigrated: false, imported: 0, alreadyImported: 0, linkedBatchFiles: 0, issues: [] as string[] };
  const previousConfig = join(root, '.pi', 'audio-understand.local.json');
  const nextConfig = join(root, '.pi', 'audio-ask.local.json');
  if (await exists(previousConfig) && !await exists(nextConfig)) {
    const config = JSON.parse(await readFile(previousConfig, 'utf8'));
    if (!isObject(config)) throw new Error('Legacy configuration must be an object.');
    const limits = isObject(config.limits) ? { ...config.limits } : {};
    delete limits.cacheMaxAgeMs;
    config.api = 'openai-completions';
    config.audioDataFormat = 'data-url';
    config.limits = { ...limits, maxItemsPerRequest: 8 };
    config.retry = { maxAttempts: 3, baseDelayMs: 1000 };
    await writeFile(nextConfig, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rm(previousConfig);
    report.configMigrated = true;
  }
  const directory = join(root, '.cache', 'audio-understand');
  if (!await exists(directory)) return report;
  const entries: { key: string; file: string; value: Record<string, any> }[] = [];
  for (const file of (await readdir(directory)).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).sort()) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, file), 'utf8'));
      if (!isObject(parsed) || !isObject(parsed.result) || typeof parsed.result.question !== 'string' || !Array.isArray(parsed.result.sources)) {
        throw new Error('Unsupported legacy record.');
      }
      entries.push({ key: file.slice(0, -5), file: join(directory, file), value: parsed.result });
    } catch (error) { report.issues.push(`${file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const referenced = new Set(entries.flatMap(entry => Array.isArray(entry.value.batches)
    ? entry.value.batches.flatMap((batch: any) => typeof batch.cache?.key === 'string' ? [batch.cache.key] : []) : []));
  const archiveRoot = join(root, '.media', 'audio-ask');
  for (const entry of entries) {
    if (referenced.has(entry.key)) { report.linkedBatchFiles++; continue; }
    try {
      const { value } = entry;
      if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Legacy record needs a valid creation time.');
      const sources: SourceRecord[] = value.sources.map((source: any) => {
        if (!source?.submitted) return source;
        const estimated = !Number.isFinite(source.submitted.start) || !Number.isFinite(source.submitted.end);
        const start = Number.isFinite(source.submitted.start) ? source.submitted.start : source.start;
        const duration = Number.isFinite(source.submitted.duration) ? source.submitted.duration : source.end - source.start;
        return {
          ...source, requested: source.requested ?? { start: source.start, end: source.end },
          ...(estimated ? { timeMapping: 'legacy-estimate' } : {}),
          submitted: { ...source.submitted, duration, start, end: Number.isFinite(source.submitted.end) ? source.submitted.end : start + duration },
        };
      });
      for (const source of sources) {
        if (!source || !/^[a-f0-9]{64}$/.test(source.sha256) || typeof source.path !== 'string' || !source.submitted
          || ![source.start, source.end, source.submitted.start, source.submitted.end].every(Number.isFinite)) throw new Error('Legacy source mapping is incomplete.');
      }
      const items: ItemRecord[] = sources.map((source, i) => ({
        id: `item-${i + 1}`, sources: [{ path: source.path, start: source.start, end: source.end }],
        prepared: [source], status: 'pending',
      }));
      const oldBatches = Array.isArray(value.batches) ? value.batches : [{
        id: 'batch-1', sourceIds: sources.map(source => source.id), status: 'completed',
        answer: value.answer, usage: value.usage, responseModel: value.responseModel, requestId: value.requestId,
      }];
      const batches: BatchRecord[] = [];
      for (const old of oldBatches) {
        if (old.status === 'not_sent') continue;
        const selected = items.filter(item => old.sourceIds?.includes(item.prepared[0].id));
        const completed = old.status === 'completed';
        for (const item of selected) { item.status = completed ? 'completed' : 'failed'; item.error = old.error; }
        batches.push({
          id: old.id, itemIds: selected.map(item => item.id), status: completed ? 'completed' : 'failed',
          encodedAudioBytes: old.encodedAudioBytes ?? selected.reduce((sum, item) => sum + 4 * Math.ceil(item.prepared[0].submitted.bytes / 3), 0),
          answer: old.answer, usage: old.usage, responseModel: old.responseModel, requestId: old.requestId,
          error: old.error, attempts: [],
        });
      }
      const completed = items.filter(item => item.status === 'completed').length;
      const files = [entry.file, ...oldBatches.flatMap((batch: any) => typeof batch.cache?.key === 'string'
        ? [join(directory, `${batch.cache.key}.json`)] : [])];
      const record: Consultation = {
        version: 1, id: `${value.createdAt.replace(/[-:.]/g, '')}-legacy-${entry.key}`,
        title: value.question.trim().split('\n')[0].slice(0, 100) || 'Imported audio consultation', question: value.question,
        mode: items.length > 1 ? 'batch' : 'ask', createdAt: value.createdAt, updatedAt: value.createdAt,
        status: completed === items.length && items.length ? 'completed' : completed ? 'partial' : 'failed',
        model: typeof value.model === 'string' ? value.model : 'unknown', endpoint: typeof value.endpoint === 'string' ? value.endpoint : 'unknown',
        requestParams: {}, items, batches, warnings: [
          ...(Array.isArray(value.warnings) ? value.warnings : []),
          ...(sources.some(source => source.timeMapping === 'legacy-estimate')
            ? ['Legacy submitted offsets are estimated from the requested source start and recorded clip duration. Verify against the original audio for precise synchronization.'] : []),
        ],
        legacy: { key: entry.key, files: [...new Set(files)] },
      };
      if (await exists(archivePaths(archiveRoot, record).recordPath)) { report.alreadyImported++; continue; }
      await saveRecord(archiveRoot, record, false);
      report.imported++;
    } catch (error) { report.issues.push(`${entry.file}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  await rebuildIndexes(archiveRoot);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root = process.cwd()] = process.argv.slice(2);
  if (command === 'migrate') console.log(JSON.stringify(await migrateLegacy(resolve(root)), null, 2));
  else if (command === 'rebuild') await rebuildIndexes(join(resolve(root), '.media', 'audio-ask'));
  else throw new Error('Usage: node maintenance.ts migrate|rebuild [workspace-root]');
}
