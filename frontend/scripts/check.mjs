/** Syntax-check maintained source, never generated dependencies or bundles. */
import {readdir, readFile, stat} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(location));
    else if (/\.(?:m?js|cjs)$/.test(entry.name)) found.push(location);
  }
  return found;
}
const sources = [...await sourceFiles(path.join(frontend, 'src')), ...await sourceFiles(path.join(frontend, 'scripts'))];
for (const filename of sources) {
  const result = spawnSync(process.execPath, ['--check', filename], {stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
const manifest = JSON.parse(await readFile(path.join(frontend, 'build-manifest.json'), 'utf8'));
if (manifest.format !== 1) throw new Error('Unsupported frontend build manifest');
const targets = new Set();
for (const entry of [...manifest.copy, ...manifest.bundles]) {
  const source = path.resolve(frontend, entry.source);
  if (!source.startsWith(frontend + path.sep) || !(await stat(source)).isFile()) {
    throw new Error(`Invalid browser source: ${entry.source}`);
  }
  if (path.basename(entry.target) !== entry.target || targets.has(entry.target)) {
    throw new Error(`Invalid or repeated browser output: ${entry.target}`);
  }
  targets.add(entry.target);
}
console.log(`Checked ${sources.length} JavaScript sources and ${targets.size} build outputs.`);
