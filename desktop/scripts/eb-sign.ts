import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

if (process.platform !== 'darwin') {
  throw new Error('Obol ad-hoc signing is only supported on macOS');
}

const runtimeArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null;
if (!runtimeArch) throw new Error(`Unsupported macOS architecture: ${process.arch}`);

const bundle = join(ROOT, 'build', `stable-macos-${runtimeArch}`, 'Obol.app');
if (!existsSync(bundle)) throw new Error(`Electrobun bundle not found: ${bundle}`);

run(['codesign', '--force', '--deep', '--sign', '-', bundle]);
run(['codesign', '--verify', '--strict', '--deep', bundle]);
console.log(`Ad-hoc signed and verified ${bundle}`);
