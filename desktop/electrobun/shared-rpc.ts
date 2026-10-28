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

/** Only the desktop API request is exposed to the trusted main Obol window. */
export type ObolBridgeSchema = {
  bun: {
    requests: {
      'api.fetch': { params: ApiFetchRequest; response: ApiFetchResponse };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {};
  };
};
