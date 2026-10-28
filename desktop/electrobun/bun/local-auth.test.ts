import { describe, expect, test } from 'bun:test';
import { createLocalAccount, verifyLocalAccount } from './local-auth';

describe('local profile credentials', () => {
  test('first-run credentials unlock the profile and derive a stable PocketBase password', async () => {
    const created = await createLocalAccount({
      name: 'Caio',
      email: 'Caio@Example.com',
      password: 'correct horse battery'
    }, new Uint8Array(16).fill(7));

    expect(created.profile.email).toBe('caio@example.com');
    expect(JSON.stringify(created.profile)).not.toContain('correct horse battery');
    expect(await verifyLocalAccount({
      email: 'CAIO@example.com',
      password: 'correct horse battery'
    }, created.profile)).toBe(created.pocketBasePassword);
  });

  test('wrong email or password cannot unlock a local profile', async () => {
    const created = await createLocalAccount({
      name: 'Caio',
      email: 'caio@example.com',
      password: 'correct horse battery'
    }, new Uint8Array(16).fill(9));

    expect(await verifyLocalAccount({ email: 'other@example.com', password: 'correct horse battery' }, created.profile)).toBeNull();
    expect(await verifyLocalAccount({ email: 'caio@example.com', password: 'wrong password' }, created.profile)).toBeNull();
  });

  test('profile creation rejects malformed email and short passwords', async () => {
    await expect(createLocalAccount({ name: 'Caio', email: 'not-an-email', password: 'correct horse battery' }))
      .rejects.toThrow('Enter a valid email address.');
    await expect(createLocalAccount({ name: 'Caio', email: 'caio@example.com', password: 'short' }))
      .rejects.toThrow('Password must be between 8 and 256 characters.');
  });
});
