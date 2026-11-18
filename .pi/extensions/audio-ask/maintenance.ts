import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rebuildIndexes } from './archive.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root = process.cwd()] = process.argv.slice(2);
  if (command !== 'rebuild') throw new Error('Usage: node maintenance.ts rebuild [workspace-root]');
  await rebuildIndexes(join(resolve(root), '.media', 'audio-ask'));
}
