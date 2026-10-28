import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SOURCE = join(ROOT, '..', 'db', 'pb_migrations');
const OUTPUT = join(ROOT, 'build', 'pb_migrations');

export async function prepareMigrations(): Promise<string> {
  await mkdir(join(ROOT, 'build'), { recursive: true });
  await rm(OUTPUT, { recursive: true, force: true });
  await cp(SOURCE, OUTPUT, { recursive: true });
  return OUTPUT;
}
