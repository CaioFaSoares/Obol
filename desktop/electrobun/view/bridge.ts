import { Electroview } from 'electrobun/view';
import type {
  ApiFetchRequest,
  ApiFetchResponse,
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
  }
};

new Electroview({ rpc });
