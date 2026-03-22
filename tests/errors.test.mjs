import test from "node:test";
import assert from "node:assert/strict";

import { APIError, HTTPError, NoContextTokenError, RequestError } from "../dist/errors.js";

test("APIError reports session expiry consistently", () => {
  assert.notEqual(new APIError(-1, -14, "session expired").message, "");
  assert.equal(new APIError(0, -14, "").isSessionExpired(), true);
  assert.equal(new APIError(-14, 0, "").isSessionExpired(), true);
  assert.equal(new APIError(-14, -14, "").isSessionExpired(), true);
  assert.equal(new APIError(-1, -1, "").isSessionExpired(), false);
  assert.equal(new APIError(0, 0, "").isSessionExpired(), false);
});

test("HTTPError, RequestError, and NoContextTokenError expose expected behavior", () => {
  const httpError = new HTTPError(500, "internal error", { "x-test": "1" });
  assert.notEqual(httpError.message, "");
  assert.equal(httpError.statusCode, 500);
  assert.equal(httpError.body, "internal error");
  assert.deepEqual(httpError.headers, { "x-test": "1" });

  const timeoutError = new RequestError("timeout", { cause: new DOMException("aborted", "AbortError") });
  assert.equal(timeoutError.isTimeout(), true);
  assert.equal(new RequestError("boom").isTimeout(), false);

  assert.notEqual(new NoContextTokenError().message, "");
});
