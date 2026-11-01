import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePocketBase } from './ensure-pocketbase';
import { prepareMigrations } from './prepare-migrations';
import { generateConfig } from './gen-electrobun-config';

const ROOT = join(import.meta.dir, '..');
const REPO_ROOT = join(ROOT, '..');
const APP_ROOT = join(REPO_ROOT, 'app');
const DEV_ID = 'copland.obol.eb-dev';
const DEV_PORT = Number(process.env.OBOL_DEV_PORT) || 3303;

function bun(): string {
  return Bun.which('bun') ?? process.execPath;
}

function electrobun(): string[] {
  const local = join(ROOT, 'node_modules', '.bin', 'electrobun');
  return existsSync(local)
    ? [local]
    : [bun(), 'x', 'electrobun'];
}

function run(command: string[], cwd: string, label: string, env: NodeJS.ProcessEnv): void {
  const result = Bun.spawnSync(command, { cwd, env, stdio: ['inherit', 'inherit', 'inherit'] });
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${result.exitCode ?? 'unknown'}`);
  }
}

const NUXT_READY_TIMEOUT_MS = 30_000;

async function waitForNuxt(baseUrl: string, server: Bun.Subprocess): Promise<void> {
  const viteUrl = new URL('/_nuxt/@vite/client', baseUrl).toString();
  const documentUrl = new URL('/', baseUrl).toString();
  const deadline = Date.now() + NUXT_READY_TIMEOUT_MS;
  let lastStatus = 'no response yet';
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Nuxt dev server exited with ${server.exitCode}`);
    try {
      // Each request, including the body read, is aborted once the remaining
      // startup budget is exhausted so a hanging response cannot outlive it.
      const viteResponse = await fetch(viteUrl, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      const viteOk = viteResponse.ok;
      const viteStatus = viteResponse.status;
      // The Vite client body is never read; release it in either branch.
      await viteResponse.body?.cancel();
      if (!viteOk) {
        lastStatus = `Vite client responded with ${viteStatus}`;
      } else {
        const documentResponse = await fetch(documentUrl, {
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (!documentResponse.ok) {
          await documentResponse.body?.cancel();
          lastStatus = `application document responded with ${documentResponse.status}`;
        } else {
          const html = await documentResponse.text();
          if (html.includes('id="__nuxt"')) return;
          lastStatus = 'application document did not contain the Nuxt root element';
        }
      }
    } catch {
      // The dev server is not accepting requests yet, or a request was aborted
      // because it exceeded the remaining startup deadline.
      lastStatus = 'request failed or exceeded the remaining startup deadline';
    }
    await Bun.sleep(250);
  }
  throw new Error(`Nuxt dev server did not become ready at ${documentUrl} (${lastStatus})`);
}

async function stopNuxt(server: Bun.Subprocess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill('SIGTERM');
  const timeout = Bun.sleep(3000).then(() => null);
  await Promise.race([server.exited, timeout]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Obol Electrobun development currently supports macOS only');
  }

  const appId = process.env.OBOL_APP_ID?.trim() || DEV_ID;
  if (appId === 'copland.obol') {
    throw new Error('OBOL_APP_ID must not be copland.obol in a dev run');
  }

  await ensurePocketBase();
  await prepareMigrations();
  await generateConfig('dev');

  // Remove static-generation state so Nuxt starts with a clean SSR/HMR dev configuration.
  await rm(join(APP_ROOT, '.nuxt'), { recursive: true, force: true });
  await rm(join(APP_ROOT, '.output'), { recursive: true, force: true });

  const url = `http://127.0.0.1:${DEV_PORT}/`;
  const appEnv = {
    ...process.env,
    NUXT_PUBLIC_API_BASE: 'http://127.0.0.1:13080',
    OBOL_DESKTOP_LOCAL: 'true',
    NUXT_HOST: '127.0.0.1',
    NUXT_PORT: String(DEV_PORT)
  };
  const nuxt = Bun.spawn([bun(), 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(DEV_PORT)], {
    cwd: APP_ROOT,
    env: appEnv,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });

  try {
    await waitForNuxt(url, nuxt);
    const env = {
      ...process.env,
      OBOL_APP_ID: appId,
      OBOL_MAIN_URL: process.env.OBOL_MAIN_URL || url
    };
    run([...electrobun(), 'dev', '--env=dev'], ROOT, 'Electrobun dev', env);
  } finally {
    await stopNuxt(nuxt);
  }
}

if (import.meta.main) await main();
