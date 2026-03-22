import { SESSION_EXPIRED_ERR_CODE } from "./constants.js";

export class APIError extends Error {
  readonly ret: number;
  readonly errCode: number;
  readonly errMsg: string;

  constructor(ret: number, errCode: number, errMsg: string) {
    super(`ilink: api error ret=${ret} errcode=${errCode} errmsg=${errMsg}`);
    this.name = "APIError";
    this.ret = ret;
    this.errCode = errCode;
    this.errMsg = errMsg;
  }

  isSessionExpired(): boolean {
    return this.errCode === SESSION_EXPIRED_ERR_CODE || this.ret === SESSION_EXPIRED_ERR_CODE;
  }
}

export class HTTPError extends Error {
  readonly statusCode: number;
  readonly body: string | Uint8Array;
  readonly headers: Record<string, string>;

  constructor(statusCode: number, body: string | Uint8Array, headers: Record<string, string> = {}) {
    const bodyText =
      typeof body === "string" ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
    super(`ilink: http ${statusCode}: ${bodyText}`);
    this.name = "HTTPError";
    this.statusCode = statusCode;
    this.body = body;
    this.headers = headers;
  }
}

export class RequestError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = "RequestError";
    this.cause = options.cause;
  }

  isTimeout(): boolean {
    return this.cause instanceof DOMException && this.cause.name === "AbortError";
  }
}

export class NoContextTokenError extends Error {
  constructor() {
    super("ilink: no cached context token; user must send a message first");
    this.name = "NoContextTokenError";
  }
}
