import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface PocketBaseAsset {
  file: string;
  sha256: string;
}

interface PocketBaseManifest {
  version: string;
  assets: Record<string, PocketBaseAsset>;
}

const ROOT = join(import.meta.dir, '..');
const MANIFEST_PATH = join(ROOT, 'pocketbase.json');
const OUTPUT_DIR = join(ROOT, 'build', 'pocketbase');
const RELEASE_BASE = 'https://github.com/pocketbase/pocketbase/releases/download';

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

function platformKey(): string {
  if (process.arch === 'arm64') {
    if (process.platform !== 'darwin') {
      throw new Error(`Unsupported PocketBase platform: ${process.platform} ${process.arch}`);
    }
    return 'darwin_arm64';
  }
  if (process.arch === 'x64') {
    if (process.platform === 'darwin') return 'darwin_amd64';
    if (process.platform === 'win32') return 'windows_amd64';
    throw new Error(`Unsupported PocketBase platform: ${process.platform} ${process.arch}`);
  }
  throw new Error(`Unsupported PocketBase architecture: ${process.arch}`);
}

/**
 * Extracts the PocketBase archive. Windows ships bsdtar, which unzips
 * directly; macOS keeps the selective `unzip` invocation.
 */
function extractArchive(archivePath: string): void {
  if (process.platform === 'win32') {
    run(['tar', '-xf', archivePath, '-C', OUTPUT_DIR]);
    return;
  }
  run(['unzip', '-o', archivePath, 'pocketbase', 'LICENSE.md', '-d', OUTPUT_DIR]);
}

export async function ensurePocketBase(): Promise<string> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as PocketBaseManifest;
  const asset = manifest.assets[platformKey()];
  if (!asset) throw new Error(`No pinned PocketBase binary for ${platformKey()}`);

  await mkdir(OUTPUT_DIR, { recursive: true });
  const archivePath = join(OUTPUT_DIR, asset.file);
  const executablePath = join(OUTPUT_DIR, process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase');
  let archiveBytes: Uint8Array;
  try {
    archiveBytes = await readFile(archivePath);
  } catch {
    const url = `${RELEASE_BASE}/v${manifest.version}/${asset.file}`;
    console.log(`Downloading pinned PocketBase ${manifest.version} (${platformKey()})`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`PocketBase download failed (${response.status}): ${url}`);
    archiveBytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(archivePath, archiveBytes);
  }

  const actualSha256 = createHash('sha256').update(archiveBytes).digest('hex');
  if (actualSha256 !== asset.sha256) {
    throw new Error(`PocketBase archive checksum mismatch for ${asset.file}`);
  }

  extractArchive(archivePath);
  await stat(join(OUTPUT_DIR, 'LICENSE.md'));
  if (process.platform !== 'win32') await chmod(executablePath, 0o755);

  const version = Bun.spawnSync([executablePath, '--version'], {
    cwd: OUTPUT_DIR,
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const versionOutput = `${version.stdout.toString()}${version.stderr.toString()}`.trim();
  if (version.exitCode !== 0 || !versionOutput.includes(manifest.version)) {
    throw new Error(`Unexpected PocketBase executable version: ${versionOutput}`);
  }

  return executablePath;
}

if (import.meta.main) {
  console.log(await ensurePocketBase());
}
