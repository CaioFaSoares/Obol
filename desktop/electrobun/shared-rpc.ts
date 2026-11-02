export interface ApiFetchRequest {
  path: string;
  method: string;
  headers: Array<[string, string]>;
  body?: string;
}

export interface ApiFetchResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

export interface LocalAccountSummary {
  name: string;
  email: string;
}

export interface LocalAuthStatus {
  setupRequired: boolean;
  account: LocalAccountSummary | null;
}

export interface LocalAuthSetupRequest {
  name: string;
  email: string;
  password: string;
}

export interface LocalAuthUnlockRequest {
  email: string;
  password: string;
}

/** Snapshot of the desktop auto-update pipeline, published from bun to the view. */
export interface DesktopUpdaterState {
  status: string;
  message: string;
  currentVersion: string;
  availableVersion: string;
  updateAvailable: boolean;
  updateReady: boolean;
  progress: number | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Desktop station replication (E007 / D016 D7/D11)
// ---------------------------------------------------------------------------

/** JSON value carried verbatim across the bridge; never a credential. */
export type DesktopJsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: DesktopJsonValue }
  | readonly DesktopJsonValue[];

export type DesktopJsonObject = { readonly [key: string]: DesktopJsonValue };

/** Exclusive runtime state of one desktop station. */
export type DesktopStationPhase =
  | 'standalone'
  | 'offline'
  | 'syncing'
  | 'upToDate'
  | 'authRequired'
  | 'conflict'
  | 'error'
  | 'blocked';

/**
 * Truthful station status. It never carries a token, password, server
 * credential or operation payload. `dataRevision` changes only when actual
 * financial working data changes, never because the view polled.
 */
export interface DesktopStationStatus {
  phase: DesktopStationPhase;
  isPaired: boolean;
  stationId: string;
  serverUrl: string | null;
  serverName: string | null;
  detail: string | null;
  lastSyncAt: string | null;
  pendingCount: number;
  conflictCount: number;
  dataRevision: number;
}

/** Actions the pairing UI may render, exactly as computed by the backend. */
export type DesktopPairingActionId =
  | 'resume'
  | 'useServerData'
  | 'importLocalData'
  | 'seedEmptyServer'
  | 'stayLocal';

export interface DesktopPairingAction {
  id: DesktopPairingActionId;
  label: string;
  isDestructive: boolean;
}

export interface DesktopPairingPreview {
  serverName: string;
  serverAddress: string;
  hasServerData: boolean;
  localEntityCount: number;
  localOperationCount: number;
  isRePairing: boolean;
  hasLocalData: boolean;
  actions: DesktopPairingAction[];
  warnings: string[];
}

export interface DesktopConnectionPreviewRequest {
  serverAddress: string;
  email: string;
  password: string;
}

export type DesktopConnectionChoice = DesktopPairingActionId;

export interface DesktopConfirmConnectionRequest {
  choice: DesktopConnectionChoice;
  /** Typed confirmation for a destructive local replace (`REPLACE`). */
  confirmation: string | null;
  /** Receipt returned by a completed `exportSnapshot()`; required for replace. */
  exportReceipt: string | null;
}

export interface DesktopSignOutResult {
  localCredentialRemoved: boolean;
  remoteRevoked: boolean;
}

export interface DesktopExportResult {
  saved: boolean;
  /**
   * Coherent-data receipt of the completed write. `null` whenever the file
   * was canceled or not written.
   */
  receipt: string | null;
}

export type DesktopOutboxStatus =
  | 'queued'
  | 'in_flight'
  | 'accepted'
  | 'conflict'
  | 'rejected';

/** One durable pending intent shown to the user; no credential fields. */
export interface DesktopOutboxEntry {
  opId: string;
  type: string;
  entityType: string;
  entityId: string;
  status: DesktopOutboxStatus;
  effectiveAt: string;
  clientCreatedAt: string;
  attempts: number;
  lastError: string | null;
  payload: DesktopJsonObject;
  baseRevisions: DesktopJsonObject;
  beforeSnapshots: DesktopJsonValue;
  dependsOn: string[];
}

/** One unresolved conflict or blocked dependency. */
export interface DesktopConflictEntry {
  opId: string;
  entityType: string;
  entityId: string;
  message: string;
  baseRevision: number | null;
  currentRevision: number;
  currentRecord: DesktopJsonValue;
  localIntent: DesktopJsonValue;
}

export type DesktopConflictResolution =
  | 'useServer'
  | 'retryWithCurrentServerRevision'
  | 'discard';

export type DesktopDependentPolicy =
  | 'blockQueued'
  | 'rejectDependents'
  | 'retryWithoutDependency';

export interface DesktopResolveConflictRequest {
  opId: string;
  resolution: DesktopConflictResolution;
  dependents: DesktopDependentPolicy;
}

export interface DesktopAcknowledgeRejectedRequest {
  opId: string;
  dependents: DesktopDependentPolicy;
}

/** Complete desktop bridge; the view can unlock, call the API and sync. */
export type ObolBridgeSchema = {
  bun: {
    requests: {
      'api.fetch': { params: ApiFetchRequest; response: ApiFetchResponse };
      'auth.status': { params: {}; response: LocalAuthStatus };
      'auth.setup': { params: LocalAuthSetupRequest; response: LocalAccountSummary };
      'auth.unlock': { params: LocalAuthUnlockRequest; response: LocalAccountSummary };
      'updater.status': { params: {}; response: DesktopUpdaterState };
      'updater.check': { params: {}; response: DesktopUpdaterState };
      'updater.install': { params: {}; response: void };
      'station.status': { params: {}; response: DesktopStationStatus };
      'station.synchronize': { params: {}; response: DesktopStationStatus };
      'station.previewConnection': {
        params: DesktopConnectionPreviewRequest;
        response: DesktopPairingPreview;
      };
      'station.confirmConnection': {
        params: DesktopConfirmConnectionRequest;
        response: DesktopStationStatus;
      };
      'station.cancelConnectionPreview': { params: {}; response: void };
      'station.disconnect': { params: {}; response: DesktopStationStatus };
      'station.signOut': { params: {}; response: DesktopSignOutResult };
      'station.outbox': { params: {}; response: DesktopOutboxEntry[] };
      'station.conflicts': { params: {}; response: DesktopConflictEntry[] };
      'station.resolveConflict': {
        params: DesktopResolveConflictRequest;
        response: DesktopStationStatus;
      };
      'station.acknowledgeRejected': {
        params: DesktopAcknowledgeRejectedRequest;
        response: DesktopStationStatus;
      };
      'station.exportSnapshot': { params: {}; response: DesktopExportResult };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {
      'updater.state': DesktopUpdaterState;
      'station.state': DesktopStationStatus;
      'station.status': DesktopStationStatus;
    };
  };
};
