import { existsSync, readFileSync } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const APP_NAME = 'Obol';

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

// Electrobun's macOS self-extractor rejects GNU tar long-link and symbolic-link entries.
const MAX_TAR_PATH_BYTES = 100;

async function assertTarPathLengths(root: string, archivePrefix: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const archivePath = `${archivePrefix}/${entry.name}`;
    if (Buffer.byteLength(archivePath, 'utf8') > MAX_TAR_PATH_BYTES) {
      throw new Error(
        `Electrobun self-extractor cannot handle tar paths longer than ${MAX_TAR_PATH_BYTES} bytes: ${archivePath}`
      );
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`Electrobun self-extractor cannot handle symbolic links: ${archivePath}`);
    }
    if (entry.isDirectory()) {
      await assertTarPathLengths(join(root, entry.name), archivePath);
    }
  }
}

/** The `win-x64-<Name>-Setup.zip` Electrobun writes into `desktop/artifacts/` for a stable build. */
function windowsSetupZip(): string {
  // Electrobun removes ASCII spaces from the app name in artifact filenames; `desktop/app.json`
  // is the same source `gen-electrobun-config.ts` reads, so this names the real artifact.
  try {
    const raw = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')) as { name?: unknown };
    const name = typeof raw.name === 'string' && raw.name !== '' ? raw.name.replace(/ /g, '') : null;
    return join(ROOT, 'artifacts', `win-x64-${name ?? APP_NAME}-Setup.zip`);
  } catch {
    return join(ROOT, 'artifacts', `win-x64-${APP_NAME}-Setup.zip`);
  }
}

type ZipEntry = { name: string; setupExecutableName: string };

function nativeWindowsTar(errorPrefix: string): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const tar = join(systemRoot, 'System32', 'tar.exe');
  if (!existsSync(tar)) {
    throw new Error(`${errorPrefix}: Windows native tar not found at ${tar} (System32 tar.exe is required for Windows paths)`);
  }
  return tar;
}

/**
 * Windows' own tar.exe (shipped in System32) lists zip members; the archive path goes in as a
 * spawn argv element, never through a shell, so quoting or injection cannot reinterpret it.
 */
function listZipEntries(setupZip: string, errorPrefix: string): ZipEntry[] {
  const tar = nativeWindowsTar(errorPrefix);
  const listing = Bun.spawnSync([tar, '-tf', setupZip], { stdout: 'pipe', stderr: 'pipe' });
  const rawEntries = listing.stdout.toString().split(/\r?\n/).map((name) => name.trim());
  if (listing.exitCode !== 0 || rawEntries.every((name) => name === '')) {
    throw new Error(`${errorPrefix}: the archive is unreadable: ${listing.stderr.toString().trim()}`);
  }
  const names = rawEntries.filter((name) => name !== '').filter((name) => !name.endsWith('/'));
  const appName = APP_NAME.toLowerCase();
  const setupExecutableName = names.find(
    (name) => name.toLowerCase().endsWith('.exe') && name.toLowerCase().includes(appName),
  );
  return names.map((name) => ({ name, setupExecutableName: setupExecutableName ?? '' }));
}

async function verifyWindows(): Promise<void> {
  if (process.arch !== 'x64') {
    throw new Error(`Obol Windows verification runs on the native x64 runner, not ${process.arch}`);
  }
  const setupZip = windowsSetupZip();
  await requireFile(setupZip);
  // The Electrobun Windows installer zip carries the visible setup executable (it keeps the
  // display name's spaces) plus its adjacent hidden installer payload; require both.
  const entries = listZipEntries(setupZip, `Electrobun setup zip ${setupZip}`);
  const setupExecutableName = entries[0]?.setupExecutableName ?? '';
  if (setupExecutableName === '') {
    throw new Error(`Electrobun setup zip ${setupZip} has no ${APP_NAME} *.exe setup executable`);
  }
  if (entries.length < 2) {
    throw new Error(`Electrobun setup zip ${setupZip} has no installer payload beside ${setupExecutableName}`);
  }
  console.log(`Verified ${setupZip}: readable archive with ${setupExecutableName} and its installer payload`);
}

async function verifyMacos(): Promise<void> {
  const runtimeArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
  if (!runtimeArch) throw new Error(`Unsupported macOS architecture: ${process.arch}`);

  const bundle = join(ROOT, 'build', `stable-macos-${runtimeArch}`, 'Obol.app');
  const resources = join(bundle, 'Contents', 'Resources');
  await requireFile(join(bundle, 'Contents', 'Info.plist'));
  await requireFile(join(bundle, 'Contents', 'MacOS', 'launcher'));
  await requireFile(join(ROOT, 'build', 'pocketbase', 'pocketbase'));
  await requireDirectory(join(ROOT, 'build', 'pb_migrations'));
  await requireFile(join(ROOT, 'dist', 'index.html'));
  await assertTarPathLengths(
    join(ROOT, 'dist'),
    'Obol.app/Contents/Resources/app/views/mainview'
  );
  await assertTarPathLengths(
    join(ROOT, 'build', 'pb_migrations'),
    'Obol.app/Contents/Resources/app/pb_migrations'
  );

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
}

if (process.platform === 'darwin') {
  await verifyMacos();
} else if (process.platform === 'win32') {
  await verifyWindows();
} else {
  throw new Error('Obol desktop verification requires macOS or a native Windows runner');
}
