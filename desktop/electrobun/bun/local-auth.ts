import { createHash, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';

const SALT_BYTES = 16;
export const LOCAL_AUTH_ITERATIONS = 600_000;
const KEY_BYTES = 32;
const ALGORITHM = 'PBKDF2-HMAC-SHA256-v1' as const;
const LOCAL_CHECK_LABEL = 'obol/local-check/v1';
const POCKETBASE_PASSWORD_LABEL = 'obol/pocketbase-superuser/v1';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface LocalAccountInput {
  name: string;
  email: string;
  password: string;
}

export interface LocalAccountProfile {
  version: 1;
  name: string;
  email: string;
  algorithm: typeof ALGORITHM;
  iterations: number;
  salt: string;
  verifier: string;
}

export interface CreatedLocalAccount {
  profile: LocalAccountProfile;
  pocketBasePassword: string;
}


function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validateInput(input: LocalAccountInput): { name: string; email: string } {
  const name = input.name.trim();
  const email = normalizeEmail(input.email);
  if (name.length === 0 || name.length > 80) {
    throw new Error('Enter a name of at most 80 characters.');
  }
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new Error('Enter a valid email address.');
  }
  if (input.password.length < 8 || input.password.length > 256) {
    throw new Error('Password must be between 8 and 256 characters.');
  }
  return { name, email };
}

function deriveKey(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    pbkdf2(
      password.normalize('NFC'),
      Buffer.from(salt),
      LOCAL_AUTH_ITERATIONS,
      KEY_BYTES,
      'sha256',
      (error, key) => error ? reject(error) : resolve(key)
    );
  });
}

function hmac(key: Buffer, label: string): Buffer {
  return createHmac('sha256', key).update(label, 'utf8').digest();
}

function deriveCredentials(masterKey: Buffer): { verifier: Buffer; pocketBasePassword: string } {
  const localKey = hmac(masterKey, LOCAL_CHECK_LABEL);
  return {
    verifier: createHash('sha256').update(localKey).digest(),
    pocketBasePassword: hmac(masterKey, POCKETBASE_PASSWORD_LABEL).toString('base64url')
  };
}

export async function createLocalAccount(
  input: LocalAccountInput,
  saltOverride?: Uint8Array
): Promise<CreatedLocalAccount> {
  const { name, email } = validateInput(input);
  const salt = saltOverride === undefined ? randomBytes(SALT_BYTES) : Buffer.from(saltOverride);
  if (salt.length !== SALT_BYTES) throw new Error('Local account salt must be 16 bytes.');

  const masterKey = await deriveKey(input.password, salt);
  const { verifier, pocketBasePassword } = deriveCredentials(masterKey);
  return {
    profile: {
      version: 1,
      name,
      email,
      algorithm: ALGORITHM,
      iterations: LOCAL_AUTH_ITERATIONS,
      salt: salt.toString('base64url'),
      verifier: verifier.toString('base64url')
    },
    pocketBasePassword
  };
}

export function parseLocalAccountProfile(serialized: string): LocalAccountProfile {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('The local account profile is unreadable. Your PocketBase data was not changed.');
  }

  if (typeof value !== 'object' || value === null) {
    throw new Error('The local account profile is invalid. Your PocketBase data was not changed.');
  }
  const profile = value as Record<string, unknown>;
  const salt = typeof profile.salt === 'string' ? Buffer.from(profile.salt, 'base64url') : null;
  const verifier = typeof profile.verifier === 'string' ? Buffer.from(profile.verifier, 'base64url') : null;
  if (
    profile.version !== 1 ||
    typeof profile.name !== 'string' || profile.name.trim().length === 0 || profile.name.length > 80 ||
    typeof profile.email !== 'string' || normalizeEmail(profile.email) !== profile.email || !EMAIL_PATTERN.test(profile.email) ||
    profile.algorithm !== ALGORITHM ||
    profile.iterations !== LOCAL_AUTH_ITERATIONS ||
    salt === null || salt.length !== SALT_BYTES ||
    verifier === null || verifier.length !== KEY_BYTES
  ) {
    throw new Error('The local account profile is invalid. Your PocketBase data was not changed.');
  }
  return profile as unknown as LocalAccountProfile;
}

export async function verifyLocalAccount(
  input: Pick<LocalAccountInput, 'email' | 'password'>,
  profile: LocalAccountProfile
): Promise<string | null> {
  if (normalizeEmail(input.email) !== profile.email || input.password.length > 256) return null;
  const salt = Buffer.from(profile.salt, 'base64url');
  const expected = Buffer.from(profile.verifier, 'base64url');
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return null;

  const masterKey = await deriveKey(input.password, salt);
  const { verifier, pocketBasePassword } = deriveCredentials(masterKey);
  return timingSafeEqual(expected, verifier) ? pocketBasePassword : null;
}
