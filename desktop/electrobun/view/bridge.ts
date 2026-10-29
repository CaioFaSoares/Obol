import { Electroview } from 'electrobun/view';
import type {
  ApiFetchRequest,
  ApiFetchResponse,
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
  }
};

new Electroview({ rpc });
