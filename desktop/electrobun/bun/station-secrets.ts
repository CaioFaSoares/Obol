// OS credential storage for the desktop station session token (desktop
// offline station contract: Bun `secrets` -> macOS Keychain / Windows
// Credential Manager).
//
// Only the remote bearer token lives here. It is keyed by the server instance
// and owner fingerprint from the durable binding, never by a URL the user can
// retarget silently. No password, local account verifier or PocketBase
// credential is stored. A credential-store failure is actionable and never
// deletes or rewrites local finance.

import { secrets } from 'bun';

import type { StationBinding } from '../../../server/src/domain/sync/StationProtocol';

/** Credential-store failure with an actionable, non-secret message. */
export class StationCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StationCredentialError';
  }
}

function actionable(error: unknown): StationCredentialError {
  const reason = error instanceof Error ? error.message : String(error);
  return new StationCredentialError(
    `Obol could not access the operating system credential store (${reason}). Local finance remains available and untouched; unlock the Keychain/Credential Manager and retry.`,
  );
}

/** One OS-backed token slot per server instance/owner tuple. */
export class StationSecretStore {
  constructor(private readonly service: string) {}

  /**
   * Stable credential name. It is scoped to the normalized server origin AND
   * this local profile/station, so pointing the profile at another origin or
   * pairing a different station can never read an old bearer token. Both
   * values come from the durable bound station state; an empty binding never
   * reads an old token. The `service` is the application identifier (the local
   * profile), so two profiles never share a credential slot either.
   */
  private nameFor(binding: StationBinding): string {
    if (
      binding.serverUrl === '' ||
      binding.stationId === '' ||
      binding.serverInstanceId === '' ||
      binding.ownerFingerprint === ''
    ) {
      throw new StationCredentialError(
        'This profile is not bound to a server, so there is no station credential to read.',
      );
    }
    let origin: string;
    try {
      origin = new URL(binding.serverUrl).origin;
    } catch {
      throw new StationCredentialError(
        'The stored server address is not a valid origin; sign in again to bind a fresh session.',
      );
    }
    if (origin !== binding.serverUrl) {
      // The binding is always stored normalized; refuse a silently different
      // spelling instead of hashing a retargeted address into the key.
      throw new StationCredentialError(
        'The stored server address is not normalized; sign in again to bind a fresh session.',
      );
    }
    const owner = binding.ownerFingerprint.slice(-24);
    return `station-session:${origin}:${binding.stationId}:${binding.serverInstanceId}:${owner}`;
  }

  /** Reads the bearer token, or `null` when this station has none. */
  async read(binding: StationBinding): Promise<string | null> {
    try {
      return await secrets.get({
        service: this.service,
        name: this.nameFor(binding)
      });
    } catch (error) {
      throw actionable(error);
    }
  }

  /**
   * Stores or rotates the bearer token in the OS credential store. On Windows
   * the credential is scoped to the current computer (`persist: 'local'`), so
   * a roaming profile does not carry one device's session.
   */
  async write(binding: StationBinding, token: string): Promise<void> {
    if (token.length === 0) {
      throw new StationCredentialError('Refusing to store an empty station token.');
    }
    try {
      await secrets.set({
        service: this.service,
        name: this.nameFor(binding),
        value: token,
        persist: 'local'
      });
    } catch (error) {
      throw actionable(error);
    }
  }

  /** Deletes the token; `false` means nothing was stored. */
  async delete(binding: StationBinding): Promise<boolean> {
    try {
      return await secrets.delete({
        service: this.service,
        name: this.nameFor(binding)
      });
    } catch (error) {
      throw actionable(error);
    }
  }
}
