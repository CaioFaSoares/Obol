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

/** The desktop view can unlock one local profile and then call the existing Obol API. */
export type ObolBridgeSchema = {
  bun: {
    requests: {
      'api.fetch': { params: ApiFetchRequest; response: ApiFetchResponse };
      'auth.status': { params: {}; response: LocalAuthStatus };
      'auth.setup': { params: LocalAuthSetupRequest; response: LocalAccountSummary };
      'auth.unlock': { params: LocalAuthUnlockRequest; response: LocalAccountSummary };
    };
    messages: {};
  };
  webview: {
    requests: {};
    messages: {};
  };
};
