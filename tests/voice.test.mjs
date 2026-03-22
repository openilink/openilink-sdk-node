import test from "node:test";
import assert from "node:assert/strict";

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
