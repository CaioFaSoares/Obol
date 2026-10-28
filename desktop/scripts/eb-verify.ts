import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

async function requireFile(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`Required desktop bundle file is missing: ${path}`);
  }
}

async function requireDirectory(path: string): Promise<void> {
  try {
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Required desktop bundle directory is missing: ${path}`);
  }
}

if (process.platform !== 'darwin') throw new Error('Obol desktop verification requires macOS');
const runtimeArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
if (!runtimeArch) throw new Error(`Unsupported macOS architecture: ${process.arch}`);

const bundle = join(ROOT, 'build', `stable-macos-${runtimeArch}`, 'Obol.app');
const resources = join(bundle, 'Contents', 'Resources');
await requireFile(join(bundle, 'Contents', 'Info.plist'));
await requireFile(join(bundle, 'Contents', 'MacOS', 'launcher'));
await requireFile(join(ROOT, 'build', 'pocketbase', 'pocketbase'));
await requireDirectory(join(ROOT, 'build', 'pb_migrations'));
await requireFile(join(ROOT, 'dist', 'index.html'));

const plist = await readFile(join(bundle, 'Contents', 'Info.plist'), 'utf8');
if (!plist.includes('<string>copland.obol</string>') || !plist.includes('<string>Obol</string>')) {
  throw new Error('Electrobun Info.plist does not contain Obol release identity');
}

const resourcesInBundle = await readdir(resources);
if (!resourcesInBundle.some(name => name.endsWith('.tar.zst'))) {
  throw new Error('Electrobun app bundle is missing its self-extracting resources payload');
}

const signature = Bun.spawnSync(['codesign', '--verify', '--strict', '--deep', bundle], {
  cwd: ROOT,
  stdout: 'pipe',
  stderr: 'pipe'
});
if (signature.exitCode !== 0) {
  throw new Error(`App signature verification failed: ${signature.stderr.toString()}`);
}

console.log(`Verified ${bundle}, app identity, signature, and staged PocketBase/migrations`);
