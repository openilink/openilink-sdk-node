import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_BASE_URL, DEFAULT_BOT_TYPE, DEFAULT_CDN_BASE_URL } from "../dist/constants.js";
import { Client } from "../dist/client.js";
import { HTTPError, NoContextTokenError } from "../dist/errors.js";

test("Client preserves defaults and explicit configuration", () => {
  const client = new Client("mytoken");
  assert.equal(client.token, "mytoken");
  assert.equal(client.baseUrl, DEFAULT_BASE_URL);
  assert.equal(client.cdnBaseUrl, DEFAULT_CDN_BASE_URL);
  assert.equal(client.botType, DEFAULT_BOT_TYPE);
  assert.equal(client.version, "1.0.2");

  const custom = new Client("tok", {
    base_url: "https://custom.example.com",
    cdn_base_url: "https://cdn.custom.example.com",
    bot_type: "5",
    version: "2.0.0",
    route_tag: "route-1",
  });
  assert.equal(custom.baseUrl, "https://custom.example.com");
  assert.equal(custom.cdnBaseUrl, "https://cdn.custom.example.com");
  assert.equal(custom.botType, "5");
  assert.equal(custom.version, "2.0.0");
  assert.equal(custom.routeTag, "route-1");
});

test("Client caches context tokens and rejects push without one", async () => {
  const client = new Client("");
  assert.equal(client.getContextToken("user1"), undefined);

  client.setContextToken("user1", "tok1");
  assert.equal(client.getContextToken("user1"), "tok1");
  client.setContextToken("user1", "tok2");
  assert.equal(client.getContextToken("user1"), "tok2");

  await assert.rejects(client.push("missing-user", "hello"), NoContextTokenError);
});

test("Client build helpers trim Authorization and keep base_info stable", () => {
  const client = new Client("  my-token  ", { route_tag: "route-x", version: "3.0.0" });
  const headers = client.buildHeaders('{"test":true}', { "Content-Type": "application/json" });
  const uploadHeaders = client.buildUploadHeaders(Buffer.from("binary-data"));

  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.AuthorizationType, "ilink_bot_token");
  assert.equal(headers.Authorization, "Bearer my-token");
  assert.equal(headers.SKRouteTag, "route-x");
  assert.equal(headers["Content-Length"], "13");
  assert.ok(headers["X-WECHAT-UIN"]);
  assert.deepEqual(client.buildBaseInfo(), { channel_version: "3.0.0" });

  assert.deepEqual(uploadHeaders, {
    "Content-Type": "application/octet-stream",
    "Content-Length": "11",
  });
});

test("getUpdates posts the expected payload and decodes the response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://api.example.com/ilink/bot/getupdates");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer tok");
    assert.equal(init.headers.SKRouteTag, "route-x");

    const payload = JSON.parse(init.body);
    assert.equal(payload.get_updates_buf, "cursor-0");
    assert.deepEqual(payload.base_info, { channel_version: "1.0.2" });

    return new Response(
      JSON.stringify({
        ret: 0,
        msgs: [{ message_id: 1 }],
        get_updates_buf: "cursor-1",
        longpolling_timeout_ms: 40_000,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const client = new Client("tok", { base_url: "https://api.example.com", route_tag: "route-x" });
  const response = await client.getUpdates("cursor-0");

  assert.equal(response.ret, 0);
  assert.equal(response.msgs.length, 1);
  assert.equal(response.get_updates_buf, "cursor-1");
  assert.equal(response.longpolling_timeout_ms, 40_000);
});

test("sendText includes an explicit empty from_user_id field", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let captured;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };

  const client = new Client("tok", { base_url: "https://api.example.com" });
  await client.sendText("user-1", "hello", "ctx-1");

  assert.equal(captured.msg.from_user_id, "");
  assert.ok(Object.hasOwn(captured.msg, "from_user_id"));
});

test("request helpers disable redirect following and treat 3xx as HTTPError", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (_url, init) => {
    assert.equal(init.redirect, "manual");
    return new Response("moved", {
      status: 301,
      headers: { location: "https://api.example.com/redirected" },
    });
  };

  const client = new Client("tok", { base_url: "https://api.example.com" });
  await assert.rejects(client.getUpdates(""), HTTPError);
});

test("CDN uploads omit API auth headers and prefer x-error-message", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let seenHeaders;
  globalThis.fetch = async (_url, init) => {
    seenHeaders = init.headers;
    return new Response("ignored body", {
      status: 503,
      headers: { "x-error-message": "cdn busy" },
    });
  };

  const client = new Client("tok", { base_url: "https://api.example.com", route_tag: "route-x" });
  await assert.rejects(
    client.doUpload("https://cdn.example.com/upload", Buffer.from("payload")),
    (error) => {
      assert.ok(error instanceof HTTPError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.body, "cdn busy");
      return true;
    },
  );

  assert.deepEqual(seenHeaders, {
    "Content-Type": "application/octet-stream",
    "Content-Length": "7",
  });
});

test("monitor caches context tokens, updates buf, and reuses dynamic timeout", async (t) => {
  let requestCount = 0;
  let keepRunning = true;
  const received = [];
  const timeouts = [];
  let savedBuf = "";

  const client = new Client("tok", { base_url: "https://api.example.com" });
  const originalDoPost = client.doPost;
  t.after(() => {
    client.doPost = originalDoPost;
  });

  client.doPost = async (_endpoint, payload, timeoutMs) => {
    requestCount += 1;
    timeouts.push(timeoutMs);

    if (requestCount === 1) {
      assert.equal(payload.get_updates_buf, "");
      return JSON.stringify({
        ret: 0,
        msgs: [
          {
            message_id: 1,
            from_user_id: "u1",
            context_token: "ct1",
            item_list: [{ type: 1, text_item: { text: "hi" } }],
          },
          {
            message_id: 2,
            from_user_id: "u2",
            context_token: "ct2",
          },
        ],
        get_updates_buf: "buf-1",
        longpolling_timeout_ms: 50_000,
      });
    }

    keepRunning = false;
    assert.equal(payload.get_updates_buf, "buf-1");
    return JSON.stringify({ ret: 0, msgs: [] });
  };

  await client.monitor(
    async (message) => {
      received.push(message);
    },
    {
      on_buf_update: (buf) => {
        savedBuf = buf;
      },
      should_continue: () => keepRunning,
    },
  );

  assert.equal(received.length, 2);
  assert.equal(savedBuf, "buf-1");
  assert.equal(client.getContextToken("u1"), "ct1");
  assert.equal(client.getContextToken("u2"), "ct2");
  assert.deepEqual(timeouts, [35_000, 50_000]);
});

test("loginWithQr mirrors the Go login flow behavior", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalSleep = Client.prototype.sleep;

  t.after(() => {
    globalThis.fetch = originalFetch;
    Client.prototype.sleep = originalSleep;
  });

  let pollCount = 0;
  globalThis.fetch = async (url) => {
    const parsedUrl = new URL(url);

    if (parsedUrl.pathname.endsWith("/ilink/bot/get_bot_qrcode")) {
      return new Response(
        JSON.stringify({
          qrcode: "qr1",
          qrcode_img_content: "img1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (parsedUrl.pathname.endsWith("/ilink/bot/get_qrcode_status")) {
      pollCount += 1;
      const body =
        pollCount === 1
          ? { status: "wait" }
          : pollCount === 2
            ? { status: "scaned" }
            : {
                status: "confirmed",
                bot_token: "bot-token",
                ilink_bot_id: "bot-id",
                baseurl: "https://new-base.com",
                ilink_user_id: "user-id",
              };

      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`unexpected url: ${url}`);
  };

  Client.prototype.sleep = async () => {};

  const client = new Client("", { base_url: "https://api.example.com" });
  let qrImage = "";
  let scanned = false;

  const result = await client.loginWithQr(
    {
      on_qrcode: (image) => {
        qrImage = image;
      },
      on_scanned: () => {
        scanned = true;
      },
    },
    100,
  );

  assert.equal(result.connected, true);
  assert.equal(result.bot_token, "bot-token");
  assert.equal(result.bot_id, "bot-id");
  assert.equal(result.user_id, "user-id");
  assert.equal(qrImage, "img1");
  assert.equal(scanned, true);
  assert.equal(client.token, "bot-token");
  assert.equal(client.baseUrl, "https://new-base.com");
});
