// Recorded after Vite finishes; verifies source inputs and the exact served assets.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = path.posix.join(root, entry.name);
    return entry.isDirectory() ? files(name) : entry.isFile() ? [name] : [];
  }).sort();
}
const roots = ['package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'index.html'];
const inputs = Object.fromEntries([...roots.filter(existsSync), ...files('src'), ...files('public'), ...files('eslint')].sort().map((name) => [name, digest(name)]));
const assets = Object.fromEntries(files('build').map((name) => [name.slice('build/'.length), digest(name)]));
if (!/^[0-9a-f]{40}$/.test(process.env.BUILD_ID || '')) throw new Error('Full source SHA required');
if (!assets['index.html'] || !Object.keys(assets).some((p) => p.startsWith('assets/') && p.endsWith('.js'))) throw new Error('Missing built client assets');
writeFileSync('build/source-build.json', JSON.stringify({ source_sha: process.env.BUILD_ID, inputs, assets }) + '\n');
