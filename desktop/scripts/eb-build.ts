import { existsSync } from 'node:fs';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePocketBase } from './ensure-pocketbase';
import { prepareMigrations } from './prepare-migrations';

const ROOT = join(import.meta.dir, '..');
const REPO_ROOT = join(ROOT, '..');
const APP_ROOT = join(REPO_ROOT, 'app');

function run(command: string[], cwd: string, label: string, env = process.env): void {
  const result = Bun.spawnSync(command, { cwd, env, stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode ?? 'unknown'}`);
  }
}

async function buildNuxtView(): Promise<void> {
  try {
    await stat(join(APP_ROOT, 'node_modules', 'nuxt'));
  } catch {
    throw new Error('Nuxt dependencies are missing; run `npm ci` in app/ first');
  }

  const env = {
    ...process.env,
    OBOL_DESKTOP_STATIC: 'true',
    NUXT_PUBLIC_API_BASE: 'http://127.0.0.1:13080'
  };
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run([npmCommand, 'run', 'generate'], APP_ROOT, 'Nuxt static generation', env);

  const generatedView = join(APP_ROOT, '.output', 'public');
  const destination = join(ROOT, 'dist');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(generatedView, destination, { recursive: true });
}

function electrobunCommand(): string[] {
  if (process.platform === 'win32') {
    const localCmd = join(ROOT, 'node_modules', '.bin', 'electrobun.cmd');
    if (existsSync(localCmd)) return [localCmd];
    const bunx = Bun.which('bun') ?? process.execPath;
    return [bunx, 'x', 'electrobun'];
  }
  const local = join(ROOT, 'node_modules', '.bin', 'electrobun');
  return existsSync(local)
    ? [local]
    : [Bun.which('bun') ?? process.execPath, 'x', 'electrobun'];
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error('Obol Electrobun builds are supported on macOS and Windows hosts only');
  }
  await ensurePocketBase();
  await prepareMigrations();
  await buildNuxtView();

  const bun = Bun.which('bun') ?? process.execPath;
  run([bun, 'scripts/gen-electrobun-config.ts', 'build'], ROOT, 'Electrobun config generation');
  run([...electrobunCommand(), 'build', '--env=stable'], ROOT, 'Electrobun bundle build');
  run([bun, 'run', 'typecheck'], ROOT, 'desktop TypeScript check');
  // Ad-hoc codesigning only applies to macOS bundles.
  if (process.platform === 'darwin') {
    run([bun, 'scripts/eb-sign.ts'], ROOT, 'ad-hoc app signing');
  }
}

if (import.meta.main) await main();
