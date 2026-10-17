/** Keep browser source separate from the offline assets shipped in the wheel. */
import {build} from 'esbuild';
import {copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(frontend, 'build-manifest.json'), 'utf8'));
const options = new Set();
let output = path.resolve(frontend, manifest.output);
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--outdir') {
    if (!args[index + 1]) throw new Error('--outdir requires a directory');
    output = path.resolve(args[++index]);
  } else if (['--assets', '--editor', '--markdown', '--workbench'].includes(arg)) {
    options.add(arg);
  } else {
    throw new Error(`Unknown build option: ${arg}`);
  }
}
const all = options.size === 0;
const defaultOutput = path.resolve(frontend, manifest.output);
if (output === frontend || output.startsWith(frontend + path.sep) || frontend.startsWith(output + path.sep)) {
  throw new Error('Browser output must not replace maintained frontend source');
}
try {
  if ((await lstat(output)).isSymbolicLink()) throw new Error('Browser output must not be a symbolic link');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.dirname(output), {recursive: true});
const staging = all ? await mkdtemp(path.join(path.dirname(output), '.slide-notes-browser-build-')) : null;
const buildOutput = staging || output;
await mkdir(buildOutput, {recursive: true});

async function inventory(directory) {
  const files = new Map();
  async function visit(current) {
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const location = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Generated assets must not contain symlinks: ${location}`);
      if (entry.isDirectory()) await visit(location);
      else if (entry.isFile()) files.set(path.relative(directory, location), createHash('sha256').update(await readFile(location)).digest('hex'));
    }
  }
  try { await visit(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files;
}

async function publishCompleteBuild() {
  const expected = await inventory(staging);
  const previous = await inventory(output);
  const obsolete = [...previous.keys()].filter(name => !expected.has(name));
  // Only the package's dedicated generated directory is eligible for pruning.
  // A custom output directory may contain unrelated files supplied by its user.
  if (output !== defaultOutput && obsolete.length) {
    throw new Error(`Custom output contains unrelated files; choose an empty directory: ${obsolete.join(', ')}`);
  }
  await mkdir(output, {recursive: true});
  for (const [name, checksum] of expected) {
    if (previous.get(name) === checksum) continue;
    const target = path.join(output, name);
    await mkdir(path.dirname(target), {recursive: true});
    const temporary = target + `.build-${process.pid}`;
    try {
      await copyFile(path.join(staging, name), temporary);
      await rename(temporary, target);
    } finally { await rm(temporary, {force: true}); }
  }
  for (const name of obsolete) await rm(path.join(output, name));
  async function pruneEmptyDirectories(directory) {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      await pruneEmptyDirectories(child);
      try { await rmdir(child); } catch (error) { if (error.code !== 'ENOTEMPTY') throw error; }
    }
  }
  await pruneEmptyDirectories(output);
  const actual = await inventory(output);
  if (actual.size !== expected.size || [...expected].some(([name, checksum]) => actual.get(name) !== checksum)) {
    throw new Error('Published browser assets differ from the complete staged build');
  }
  console.log(`Verified exact asset set and bytes: ${actual.size} files; removed ${obsolete.length} stale files.`);
}

try {
  // Classic scripts intentionally keep their separate global scopes and HTML
  // loading order. Module conversion is independent of this directory migration.
  if (all || options.has('--workbench')) {
    for (const entry of manifest.copy) {
      const target = path.join(buildOutput, entry.target);
      await mkdir(path.dirname(target), {recursive: true});
      await copyFile(path.join(frontend, entry.source), target);
    }
    console.log(`Copied ${manifest.copy.length} browser sources.`);
  }

  for (const entry of manifest.bundles) {
    const selected = entry.global === 'NotebookCodeEditor' ? '--editor' : '--markdown';
    if (!all && !options.has(selected)) continue;
    await build({
      absWorkingDir: frontend,
      entryPoints: [entry.source],
      outfile: path.join(buildOutput, entry.target),
      bundle: true,
      format: 'iife',
      globalName: entry.global,
      minify: true,
      logLevel: 'warning',
    });
    console.log(`Built ${entry.target}.`);
  }

  if (all || options.has('--assets')) {
    const result = spawnSync(process.env.PYTHON || 'python3', [
      path.join(frontend, 'scripts/build_assets.py'), '--output', buildOutput,
    ], {cwd: frontend, stdio: 'inherit'});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Asset builder failed with exit code ${result.status}`);
  }
  if (all) await publishCompleteBuild();
  console.log(`Browser output: ${output}`);
} finally {
  if (staging) await rm(staging, {recursive: true, force: true});
}
