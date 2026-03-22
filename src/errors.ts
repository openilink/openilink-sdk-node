export class RequestError extends Error {
  statusCode?: number;
  responseBody?: string;
  cause?: unknown;

  constructor(message: string, options: { statusCode?: number; responseBody?: string; cause?: unknown } = {}) {
    super(message);
    this.name = "RequestError";
    this.statusCode = options.statusCode;
    this.responseBody = options.responseBody;
    this.cause = options.cause;
  }

  isTimeout(): boolean {
    return this.cause instanceof DOMException && this.cause.name === "AbortError";
  }
}

export class NoContextTokenError extends Error {
  constructor() {
    super("No cached context token for this user; user must send a message first.");
    this.name = "NoContextTokenError";
  }
}
