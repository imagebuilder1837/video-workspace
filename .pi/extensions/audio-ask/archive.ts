import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ArchiveState, Consultation } from './types.ts';

function archivePaths(root: string, record: Consultation) {
  let title = '';
  for (const character of [...record.title.normalize('NFKC').replace(/[^\p{L}\p{N}._-]+/gu, '-')].slice(0, 64)) {
    if (Buffer.byteLength(`${record.id}--${title}${character}`) > 240) break;
    title += character;
  }
  const dir = join(root, 'records', `${record.id}--${title || 'audio'}`);
  return { recordPath: join(dir, 'record.json'), reportPath: join(dir, 'report.md') };
}

async function atomic(path: string, text: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, text, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const line = (value: string) => value.replace(/[\r\n]/g, ' ');
const link = (from: string, to: string) => relative(from, to).split(/[\\/]/).map(encodeURIComponent).join('/');

export async function readConsultation(root: string, path: string) {
  const records = await realpath(join(root, 'records'));
  const file = await realpath(path);
  if (basename(file) !== 'record.json' || dirname(dirname(file)) !== records) {
    throw new Error('Use a record.json from the Pi Audio Ask archive for continueFrom.');
  }
  const record = parseRecord(await readFile(file, 'utf8'), file);
  return { record, recordPath: join('records', basename(dirname(file)), 'record.json') };
}

function parseRecord(text: string, path: string): Consultation {
  const record = JSON.parse(text) as Consultation;
  if (record?.version !== 1 || typeof record.id !== 'string' || !Array.isArray(record.items) || !Array.isArray(record.batches)) {
    throw new Error(`Invalid audio record: ${path}`);
  }
  return record;
}

const isFingerprint = (value: string) => /^[a-f0-9]{64}$/.test(value);

function renderReport(record: Consultation): string {
  const lines = [
    `# ${record.title}`, '', `${record.id} · ${record.createdAt} · ${record.mode} · ${record.status}`,
    '', `Model: ${record.model}`, `Endpoint: ${record.endpoint} · ${record.api}`, '',
    ...(record.continuation ? [`Continues [${record.continuation.id}](../${encodeURIComponent(basename(dirname(record.continuation.recordPath)))}/report.md)`, ''] : []),
    '## Question', '', record.question, '', record.continuation ? '## Inherited audio' : '## Audio', '',
  ];
  for (const item of record.items) {
    lines.push(`### ${item.id}${item.label ? ` · ${line(item.label)}` : ''} · ${item.status}`, '');
    for (const source of item.prepared) {
      lines.push(`- ${source.id}${source.label ? ` · ${line(source.label)}` : ''}: ${line(source.path)}`,
        `  - source [${source.start}, ${source.end}); submitted [${source.submitted.start}, ${source.submitted.end}); clip 0 = source ${source.submitted.start} s`);
    }
    if (!item.prepared.length) for (const source of item.sources) lines.push(`- ${line(source.path)}`);
    if (item.error) lines.push(`Error: ${item.error}`);
    lines.push('');
  }
  for (const batch of record.batches) {
    lines.push(`## ${batch.id} · ${batch.status}`, '', `Audio groups: ${batch.itemIds.join(', ')}`, '');
    if (batch.answer) lines.push(batch.answer, '');
    if (batch.error) lines.push(`Error: ${batch.error}`, '');
    for (const attempt of batch.attempts) {
      lines.push(`- Attempt ${attempt.number} · ${attempt.startedAt}${attempt.error ? ` · ${line(attempt.error)}` : ''}${attempt.retryAfterMs !== undefined ? ` · wait ${attempt.retryAfterMs} ms` : ''}`);
    }
    lines.push('');
  }
  if (record.warnings.length) lines.push('## Notes', '', ...record.warnings.map(warning => `- ${warning}`), '');
  return lines.join('\n');
}

async function withArchiveLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, '.index.lock');
  let lock;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await delay(50);
    }
  }
  if (!lock) throw new Error(`Audio archive is busy. After closing archive writers, remove ${lockPath} to rebuild.`);
  try { return await work(); } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function readRecords(root: string) {
  const recordsDir = join(root, 'records');
  await mkdir(recordsDir, { recursive: true, mode: 0o700 });
  const records: { record: Consultation; reportPath: string }[] = [];
  for (const entry of await readdir(recordsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(recordsDir, entry.name);
    const path = join(dir, 'record.json');
    const record = parseRecord(await readFile(path, 'utf8'), path);
    records.push({ record, reportPath: join(dir, 'report.md') });
  }
  return records;
}

async function writeIndexes(root: string, records: Awaited<ReturnType<typeof readRecords>>) {
  records.sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt) || a.record.id.localeCompare(b.record.id));
  const all = ['# Pi Audio Ask', '', '## Consultations', ''];
  const assets = new Map<string, { paths: Set<string>; entries: Map<string, string> }>();
  for (const { record, reportPath } of records) {
    const names = [...new Set(record.items.flatMap(item => item.sources.map(source => basename(source.path))))];
    all.push(`- [${line(record.title)}](${link(root, reportPath)}) · ${record.createdAt} · ${record.status} · ${names.map(line).join(', ')}`);
    for (const item of record.items) for (const source of item.prepared) {
      if (!isFingerprint(source.sha256)) throw new Error(`Invalid audio fingerprint in ${record.id}.`);
      let asset = assets.get(source.sha256);
      if (!asset) assets.set(source.sha256, asset = { paths: new Set(), entries: new Map() });
      asset.paths.add(source.path);
      const assetDir = join(root, 'assets', source.sha256);
      asset.entries.set(`${record.id}:${source.id}`, `- [${line(record.title)}](${link(assetDir, reportPath)}) · ${record.createdAt} · ${source.id} · [${source.start}, ${source.end}) · ${item.status}`);
    }
  }
  all.push('', '## Audio', '');
  for (const [sha, asset] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(root, 'assets', sha, 'index.md');
    all.push(`- [${[...asset.paths].map(p => line(basename(p))).join(', ')}](${link(root, path)}) · ${sha}`);
    await atomic(path, [`# ${[...asset.paths].map(p => line(basename(p))).join(', ')}`, '', `SHA-256: ${sha}`, '',
      '## Locations', '', ...[...asset.paths].map(p => `- ${line(p)}`), '', '## Consultations', '', ...asset.entries.values(), ''].join('\n'));
  }
  await atomic(join(root, 'index.md'), all.join('\n') + '\n');
  return assets;
}

async function statIfPresent(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function pruneAssetIndexes(root: string, assets: ReadonlyMap<string, unknown>) {
  const directory = join(root, 'assets');
  const info = await statIfPresent(directory);
  if (!info?.isDirectory()) return;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isFingerprint(entry.name) || assets.has(entry.name)) continue;
    const index = join(directory, entry.name, 'index.md');
    if ((await statIfPresent(index))?.isFile()) await rm(index);
  }
}

export async function rebuildIndexes(root: string): Promise<void> {
  await withArchiveLock(root, async () => {
    const records = await readRecords(root);
    for (const { record, reportPath } of records) await atomic(reportPath, renderReport(record));
    const assets = await writeIndexes(root, records);
    await pruneAssetIndexes(root, assets);
  });
}

export async function saveRecord(root: string, record: Consultation): Promise<ArchiveState> {
  const paths = archivePaths(root, record);
  let recordSaved = false;
  try {
    await withArchiveLock(root, async () => {
      await atomic(paths.recordPath, JSON.stringify(record, null, 2) + '\n');
      recordSaved = true;
      await atomic(paths.reportPath, renderReport(record));
      await writeIndexes(root, await readRecords(root));
    });
    return { ...paths, recordSaved, saved: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = recordSaved
      ? `Consultation record saved; archive views could not be updated: ${detail}. From the workspace root run: node .pi/extensions/audio-ask/maintenance.ts rebuild`
      : `Archive save failed: ${detail}`;
    return { ...paths, recordSaved, saved: false, error: message };
  }
}
