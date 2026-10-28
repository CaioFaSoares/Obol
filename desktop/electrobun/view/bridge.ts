import { Electroview } from 'electrobun/view';
import type { ApiFetchRequest, ApiFetchResponse, ObolBridgeSchema } from '../shared-rpc';

interface ObolViewBridge {
  apiFetch(request: ApiFetchRequest): Promise<ApiFetchResponse>;
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
  apiFetch: request => rpc.request['api.fetch'](request)
};

new Electroview({ rpc });
