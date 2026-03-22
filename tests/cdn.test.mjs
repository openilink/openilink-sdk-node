import test from "node:test";
import assert from "node:assert/strict";

import {
  aesEcbPaddedSize,
  buildCdnDownloadUrl,
  buildCdnUploadUrl,
  decryptAesEcb,
  encryptAesEcb,
  mediaAesKeyHex,
  parseAESKey,
} from "../dist/cdn.js";

test("AES ECB helpers round-trip plaintext and predict padded size", () => {
  const key = Uint8Array.from({ length: 16 }, (_, index) => index);
  const cases = [
    new Uint8Array(),
    Buffer.from("hello"),
    Buffer.alloc(16, "x"),
    Buffer.alloc(32, "y"),
    Buffer.alloc(37, "z"),
    Buffer.alloc(4096, "a"),
  ];

  for (const plaintext of cases) {
    const ciphertext = encryptAesEcb(plaintext, key);
    assert.equal(ciphertext.byteLength % 16, 0);
    assert.deepEqual(Buffer.from(decryptAesEcb(ciphertext, key)), Buffer.from(plaintext));
    assert.equal(ciphertext.byteLength, aesEcbPaddedSize(plaintext.byteLength));
  }
});

test("AES ECB helpers reject invalid ciphertext shape", () => {
  const key = new Uint8Array(16);
  assert.throws(() => decryptAesEcb(Buffer.from("not-aligned-data!x"), key));
});

test("CDN URL and AES key helpers match Go behavior", () => {
  assert.equal(
    buildCdnDownloadUrl("https://cdn.example.com/c2c", "abc=123&foo"),
    "https://cdn.example.com/c2c/download?encrypted_query_param=abc%3D123%26foo",
  );
  assert.equal(
    buildCdnUploadUrl("https://cdn.example.com/c2c", "param=1", "key123"),
    "https://cdn.example.com/c2c/upload?encrypted_query_param=param%3D1&filekey=key123",
  );

  const rawKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  assert.deepEqual(Buffer.from(parseAESKey(Buffer.from(rawKey).toString("base64"))), Buffer.from(rawKey));

  const hexKey = Buffer.from(rawKey).toString("hex");
  assert.deepEqual(Buffer.from(parseAESKey(Buffer.from(hexKey, "utf8").toString("base64"))), Buffer.from(rawKey));
  assert.deepEqual(Buffer.from(parseAESKey(Buffer.from(rawKey).toString("base64url"))), Buffer.from(rawKey));

  assert.equal(
    mediaAesKeyHex("00112233445566778899aabbccddeeff"),
    Buffer.from("00112233445566778899aabbccddeeff", "utf8").toString("base64"),
  );

  assert.throws(() => parseAESKey("!!!invalid!!!"));
  assert.throws(() => parseAESKey(Buffer.from("tooshort").toString("base64")));
});
