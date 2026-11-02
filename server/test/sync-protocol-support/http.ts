// Minimal bounded JSON client for the actual BFF over HTTP. Every request has
// an explicit wall-clock deadline; a network failure or timeout is an
// environment failure the caller reports, never a classified pass.

import { EnvironmentGapError } from './config';

export interface HttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: unknown;
}

interface RequestOptions {
  readonly method?: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly rawText?: string;
  readonly contentType?: string;
  readonly path: string;
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class BffClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async request(options: RequestOptions): Promise<HttpResponse> {
    const url = `${this.baseUrl}${options.path}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
    };
    if (options.token !== undefined) {
      headers.authorization = `Bearer ${options.token}`;
    }
    let body: BodyInit | undefined;
    if (options.rawText !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json';
      body = options.rawText;
    } else if (options.body !== undefined) {
      headers['content-type'] = options.contentType ?? 'application/json';
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
      const text = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        headers: responseHeaders,
        text,
        json: parseJson(text),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new EnvironmentGapError(
          `The BFF request ${options.path} timed out after ${this.timeoutMs} ms.`,
        );
      }
      throw new EnvironmentGapError(
        `The BFF request ${options.path} failed at the transport layer (${error instanceof Error ? error.name : typeof error}).`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  get(path: string, token?: string): Promise<HttpResponse> {
    return this.request({ path, ...(token === undefined ? {} : { token }) });
  }

  post(
    path: string,
    body: unknown,
    token?: string,
    method = 'POST',
  ): Promise<HttpResponse> {
    return this.request({
      path,
      method,
      body,
      ...(token === undefined ? {} : { token }),
    });
  }

  /**
   * Sends text with a chunked request body (no declared Content-Length), so
   * the server must measure the actual bytes. Used only for the raw body
   * bound: a declared length is never trusted as the whole story.
   */
  async postChunked(
    path: string,
    text: string,
    token: string,
  ): Promise<HttpResponse> {
    const url = `${this.baseUrl}${path}`;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: stream,
        // Bun accepts a ReadableStream body without the Node duplex flag; the
        // cast keeps the call valid for Node-compatible typings too.
        ...({ duplex: 'half' } as Record<string, unknown>),
        signal: controller.signal,
      });
      const responseText = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key.toLowerCase()] = value;
      });
      return {
        status: response.status,
        headers: responseHeaders,
        text: responseText,
        json: parseJson(responseText),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new EnvironmentGapError(
          `The chunked BFF request ${path} timed out after ${this.timeoutMs} ms.`,
        );
      }
      throw new EnvironmentGapError(
        `The chunked BFF request ${path} failed at the transport layer (${error instanceof Error ? error.name : typeof error}).`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
