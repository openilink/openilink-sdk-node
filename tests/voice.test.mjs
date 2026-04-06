import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "../dist/client.js";
import { buildWAV } from "../dist/voice.js";

test("buildWAV emits a valid mono PCM header", () => {
  const pcm = Buffer.alloc(480);
  const wav = buildWAV(pcm, 24_000, 1, 16);

  assert.equal(wav.byteLength, 44 + pcm.byteLength);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString("ascii"), "WAVE");
  assert.equal(Buffer.from(wav.subarray(12, 16)).toString("ascii"), "fmt ");
  assert.equal(Buffer.from(wav.subarray(36, 40)).toString("ascii"), "data");
  assert.equal(Buffer.from(wav).readUInt32LE(4), 36 + pcm.byteLength);
  assert.equal(Buffer.from(wav).readUInt32LE(16), 16);
  assert.equal(Buffer.from(wav).readUInt16LE(20), 1);
  assert.equal(Buffer.from(wav).readUInt16LE(22), 1);
  assert.equal(Buffer.from(wav).readUInt32LE(24), 24_000);
  assert.equal(Buffer.from(wav).readUInt32LE(28), 48_000);
  assert.equal(Buffer.from(wav).readUInt16LE(32), 2);
  assert.equal(Buffer.from(wav).readUInt16LE(34), 16);
  assert.equal(Buffer.from(wav).readUInt32LE(40), pcm.byteLength);
  assert.deepEqual(wav.subarray(44), pcm);
});

test("buildWAV updates stereo-specific byte layout", () => {
  const pcm = Buffer.alloc(960);
  const wav = buildWAV(pcm, 24_000, 2, 16);

  assert.equal(Buffer.from(wav).readUInt16LE(22), 2);
  assert.equal(Buffer.from(wav).readUInt32LE(28), 96_000);
  assert.equal(Buffer.from(wav).readUInt16LE(32), 4);
});

test("downloadVoice rejects missing decoder and nil voice item", async () => {
  await assert.rejects(
    new Client("token").downloadVoice({ media: { encrypt_query_param: "x", aes_key: "y" } }),
    /no SILK decoder configured/,
  );

  const client = new Client("token", {
    silk_decoder: async () => new Uint8Array(),
  });

  await assert.rejects(client.downloadVoice(undefined), /voice item or media is nil/);
  await assert.rejects(client.downloadVoice({}), /voice item or media is nil/);
});

test("downloadVoice wraps download failures with Go-style context", async (t) => {
  const client = new Client("token", {
    silk_decoder: async () => new Uint8Array(),
  });
  const originalDownloadMedia = client.downloadMedia;

  t.after(() => {
    client.downloadMedia = originalDownloadMedia;
  });

  const downloadError = new Error("cdn failed");
  client.downloadMedia = async () => {
    throw downloadError;
  };

  await assert.rejects(client.downloadVoice({ media: { encrypt_query_param: "x", aes_key: "yQ==" } }), (error) => {
    assert.equal(error.message, "ilink: download voice: cdn failed");
    assert.equal(error.cause, downloadError);
    return true;
  });
});

test("downloadVoice wraps decoder failures and honors voice sample_rate", async (t) => {
  const client = new Client("token", {
    silk_decoder: async () => new Uint8Array([1, 2, 3, 4]),
  });
  const originalDownloadMedia = client.downloadMedia;
  const originalDecoder = client.silkDecoder;

  t.after(() => {
    client.downloadMedia = originalDownloadMedia;
    client.silkDecoder = originalDecoder;
  });

  client.downloadMedia = async () => Buffer.from("silk");
  const decodeError = new Error("decoder failed");
  client.silkDecoder = async () => {
    throw decodeError;
  };

  await assert.rejects(client.downloadVoice({ media: { encrypt_query_param: "x", aes_key: "yQ==" } }), (error) => {
    assert.equal(error.message, "ilink: decode voice: decoder failed");
    assert.equal(error.cause, decodeError);
    return true;
  });

  let seenSampleRate = 0;
  client.silkDecoder = async (_data, sampleRate) => {
    seenSampleRate = sampleRate;
    return new Uint8Array([1, 2, 3, 4]);
  };

  const wav = await client.downloadVoice({
    media: { encrypt_query_param: "x", aes_key: "yQ==" },
    sample_rate: 16_000,
  });

  assert.equal(seenSampleRate, 16_000);
  assert.equal(Buffer.from(wav).readUInt32LE(24), 16_000);
});
