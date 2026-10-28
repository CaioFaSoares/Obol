import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const sdkConfig = join(ROOT, '.hutch', 'devkit', 'tsconfig.json');
if (!existsSync(sdkConfig)) {
  throw new Error('Electrobun SDK types are missing; run `bun run eb:build` before typechecking');
}

const compiler = join(ROOT, 'node_modules', '.bin', 'tsc');
const result = Bun.spawnSync([compiler, '--noEmit', '-p', join(ROOT, 'tsconfig.json')], {
  cwd: ROOT,
  stdio: ['inherit', 'inherit', 'inherit']
});
if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
