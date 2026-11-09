import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = 'https://github.com/heygen-com/hyperframes';
const destination = fileURLToPath(new URL('../vendor/hyperframes/', import.meta.url));
const skills = ['hyperframes', 'hyperframes-cli', 'hyperframes-registry'];
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' }).trim();
const sourceNotes = await readFile(join(destination, 'SOURCES.md'), 'utf8');
const release = await fetch(`${repository}/releases/latest`, { signal: AbortSignal.timeout(30_000) });
if (!release.ok) throw new Error(`Release lookup failed: ${release.status}`);
const tag = decodeURIComponent(new URL(release.url).pathname.split('/releases/tag/')[1] ?? '');
await release.body?.cancel();
if (!tag) throw new Error('No official release tag found');

const temporary = await mkdtemp(join(tmpdir(), 'hyperframes-source-'));
const staging = await mkdtemp(fileURLToPath(new URL('../vendor/.hyperframes-update-', import.meta.url)));
const prepared = join(staging, 'prepared');
const backup = join(staging, 'previous');
let preserveBackup = false;
try {
  const upstream = join(temporary, 'upstream');
  git(temporary, 'clone', '--depth=1', '--filter=blob:none',
    '--sparse', '--branch', tag, repository, upstream);
  git(upstream, 'sparse-checkout', 'set', ...skills.map(skill => `skills/${skill}`));
  const commit = git(upstream, 'rev-parse', 'HEAD');
  for (const skill of skills) {
    await readFile(join(upstream, 'skills', skill, 'SKILL.md'));
    await cp(join(upstream, 'skills', skill), join(prepared, 'skills', skill), {
      recursive: true,
      filter: path => !/\.test\.[^/]+$|\.(woff2?|ttf|otf|ttc)$/i.test(path),
    });
  }
  await cp(join(upstream, 'LICENSE'), join(prepared, 'LICENSE'));
  try {
    await cp(join(upstream, 'NOTICE'), join(prepared, 'NOTICE'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const notes = sourceNotes
    .replace(/发布标签：`[^`]+`/, `发布标签：\`${tag}\``)
    .replace(/提交：`[^`]+`/, `提交：\`${commit}\``);
  if (!notes.includes(`发布标签：\`${tag}\``) || !notes.includes(`提交：\`${commit}\``)) {
    throw new Error('SOURCES.md is missing release or commit fields');
  }
  await writeFile(join(prepared, 'SOURCES.md'), notes);
  await rename(destination, backup);
  try {
    await rename(prepared, destination);
  } catch (error) {
    try {
      await rename(backup, destination);
    } catch (rollbackError) {
      preserveBackup = true;
      throw new AggregateError([error, rollbackError], `Restore the original files from ${backup}`);
    }
    throw error;
  }
  console.log(`Updated vendor/hyperframes to ${tag} (${commit}). Review the diff before use.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
  if (!preserveBackup) await rm(staging, { recursive: true, force: true });
}
