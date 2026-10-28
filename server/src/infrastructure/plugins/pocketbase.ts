import PocketBase from 'pocketbase';

export interface PocketBaseClientOptions {
  url: string;
  adminEmail: string;
  adminPassword: string;
  retries?: number;
  retryDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Creates and authenticates one PocketBase client after its server is reachable. */
export async function createPocketBaseClient(options: PocketBaseClientOptions): Promise<PocketBase> {
  if (!options.url || !options.adminEmail || !options.adminPassword) {
    throw new Error('PocketBase URL and superuser credentials are required');
  }

  const pb = new PocketBase(options.url);
  pb.autoCancellation(false);

  const retries = options.retries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      console.log(`🔄 Authenticating PocketBase superuser (attempt ${attempt}/${retries})...`);
      await pb.collection('_superusers').authWithPassword(
        options.adminEmail,
        options.adminPassword
      );
      console.log('✅ PocketBase superuser authenticated');
      return pb;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(retryDelayMs);
      }
    }
  }

  const details = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not authenticate PocketBase superuser after ${retries} attempts: ${details}`);
}
