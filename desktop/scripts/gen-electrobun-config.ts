import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectrobunConfig } from 'electrobun';

interface ObolManifest {
  name: string;
  title: string;
  version: string;
  size: string;
  id: string;
  urlScheme: string;
}

const ROOT = join(import.meta.dir, '..');
const RELEASE_IDENTIFIER = 'copland.obol';
const DEV_IDENTIFIER = 'copland.obol.eb-dev';

function releaseBaseUrl(): string {
  const source = process.env.OBOL_RELEASE_BASE_URL ??
    'https://github.com/CaioFaSoares/Obol/releases/latest/download';
  return `${source.replace(/\/+$/, '')}/`;
}

export async function generateConfig(mode: 'dev' | 'build'): Promise<void> {
  const manifest = JSON.parse(await readFile(join(ROOT, 'app.json'), 'utf8')) as ObolManifest;
  if (manifest.id !== RELEASE_IDENTIFIER) {
    throw new Error(`desktop/app.json id must remain ${RELEASE_IDENTIFIER}`);
  }

  const requestedId = process.env.OBOL_APP_ID?.trim();
  const identifier = requestedId || (mode === 'dev' ? DEV_IDENTIFIER : manifest.id);
  if (mode === 'dev' && identifier === RELEASE_IDENTIFIER) {
    throw new Error(`OBOL_APP_ID must not be ${RELEASE_IDENTIFIER} in a dev run`);
  }

  const config = {
    app: {
      name: manifest.title,
      identifier,
      version: manifest.version,
      urlSchemes: [manifest.urlScheme]
    },
    build: {
      mainProcess: 'bun',
      bun: { entrypoint: 'electrobun/bun/index.ts' },
      views: {
        bridge: {
          entrypoint: 'electrobun/view/bridge.ts',
          format: 'iife',
          minify: false
        }
      },
      copy: {
        dist: 'views/mainview',
        'build/pocketbase/pocketbase': 'resources/pocketbase',
        'build/pocketbase/LICENSE.md': 'resources/licenses/pocketbase-LICENSE.md',
        'build/pb_migrations': 'resources/pb_migrations'
      },
      mac: {
        bundleCEF: false,
        createDmg: false
      }
    },
    runtime: {
      exitOnLastWindowClosed: true
    },
    release: {
      baseUrl: releaseBaseUrl(),
      generatePatch: false
    }
  } satisfies ElectrobunConfig;

  const contents = `import type { ElectrobunConfig } from 'electrobun'\n\nexport default ${JSON.stringify(config, null, 2)} satisfies ElectrobunConfig\n`;
  await writeFile(join(ROOT, 'electrobun.config.ts'), contents, 'utf8');
  console.log(`Generated Electrobun ${mode} config for ${identifier}`);
}

const mode = Bun.argv[2];
if (import.meta.main) {
  if (mode !== 'dev' && mode !== 'build') throw new Error('Usage: bun scripts/gen-electrobun-config.ts <dev|build>');
  await generateConfig(mode);
}
