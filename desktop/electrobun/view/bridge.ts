import { Electroview } from 'electrobun/view';
import type {
  ApiFetchRequest,
  ApiFetchResponse,
  DesktopAcknowledgeRejectedRequest,
  DesktopConflictEntry,
  DesktopConfirmConnectionRequest,
  DesktopConnectionPreviewRequest,
  DesktopExportResult,
  DesktopOutboxEntry,
  DesktopPairingPreview,
  DesktopResolveConflictRequest,
  DesktopSignOutResult,
  DesktopStationStatus,
  DesktopUpdaterState,
  LocalAccountSummary,
  LocalAuthSetupRequest,
  LocalAuthStatus,
  LocalAuthUnlockRequest,
  ObolBridgeSchema
} from '../shared-rpc';

interface ObolViewBridge {
  apiFetch(request: ApiFetchRequest): Promise<ApiFetchResponse>;
  auth: {
    status(): Promise<LocalAuthStatus>;
    setup(request: LocalAuthSetupRequest): Promise<LocalAccountSummary>;
    unlock(request: LocalAuthUnlockRequest): Promise<LocalAccountSummary>;
  };
  updater: {
    status(): Promise<DesktopUpdaterState>;
    check(): Promise<DesktopUpdaterState>;
    install(): Promise<void>;
    subscribe(callback: (state: DesktopUpdaterState) => void): () => void;
  };
  sync: {
    status(): Promise<DesktopStationStatus>;
    synchronize(): Promise<DesktopStationStatus>;
    previewConnection(request: DesktopConnectionPreviewRequest): Promise<DesktopPairingPreview>;
    confirmConnection(request: DesktopConfirmConnectionRequest): Promise<DesktopStationStatus>;
    cancelConnectionPreview(): Promise<void>;
    disconnect(): Promise<DesktopStationStatus>;
    signOut(): Promise<DesktopSignOutResult>;
    outbox(): Promise<DesktopOutboxEntry[]>;
    conflicts(): Promise<DesktopConflictEntry[]>;
    resolveConflict(request: DesktopResolveConflictRequest): Promise<DesktopStationStatus>;
    acknowledgeRejected(request: DesktopAcknowledgeRejectedRequest): Promise<DesktopStationStatus>;
    exportSnapshot(): Promise<DesktopExportResult>;
    subscribe(callback: (state: DesktopStationStatus) => void): () => void;
  };
}

const rpc = Electroview.defineRPC<ObolBridgeSchema>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {},
    messages: {}
  }
});

const view = window as Window & { obol?: ObolViewBridge };
view.obol = {
  apiFetch: request => rpc.request['api.fetch'](request),
  auth: {
    status: () => rpc.request['auth.status']({}),
    setup: request => rpc.request['auth.setup'](request),
    unlock: request => rpc.request['auth.unlock'](request)
  },
  updater: {
    status: () => rpc.request['updater.status']({}),
    check: () => rpc.request['updater.check']({}),
    install: () => rpc.request['updater.install']({}),
    subscribe: callback => {
      const listener = (state: DesktopUpdaterState) => {
        callback(state);
      };
      rpc.addMessageListener('updater.state', listener);
      return () => {
        rpc.removeMessageListener('updater.state', listener);
      };
    }
  },
  sync: {
    status: () => rpc.request['station.status']({}),
    synchronize: () => rpc.request['station.synchronize']({}),
    previewConnection: request => rpc.request['station.previewConnection'](request),
    confirmConnection: request => rpc.request['station.confirmConnection'](request),
    cancelConnectionPreview: () => rpc.request['station.cancelConnectionPreview']({}),
    disconnect: () => rpc.request['station.disconnect']({}),
    signOut: () => rpc.request['station.signOut']({}),
    outbox: () => rpc.request['station.outbox']({}),
    conflicts: () => rpc.request['station.conflicts']({}),
    resolveConflict: request => rpc.request['station.resolveConflict'](request),
    acknowledgeRejected: request => rpc.request['station.acknowledgeRejected'](request),
    exportSnapshot: () => rpc.request['station.exportSnapshot']({}),
    subscribe: callback => {
      const listener = (state: DesktopStationStatus) => {
        callback(state);
      };
      rpc.addMessageListener('station.state', listener);
      return () => {
        rpc.removeMessageListener('station.state', listener);
      };
    }
  }
};

new Electroview({ rpc });
