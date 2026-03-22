import test from "node:test";
import assert from "node:assert/strict";

import { ExtensionFromMIME, MIMEFromFilename, isImageMIME, isVideoMIME } from "../dist/mime.js";

test("MIMEFromFilename resolves known extensions and falls back", () => {
  assert.equal(MIMEFromFilename("photo.jpg"), "image/jpeg");
  assert.equal(MIMEFromFilename("photo.JPEG"), "image/jpeg");
  assert.equal(MIMEFromFilename("archive.unknown"), "application/octet-stream");
});

test("ExtensionFromMIME resolves alias, strips parameters, and falls back", () => {
  assert.equal(ExtensionFromMIME("image/jpeg"), ".jpg");
  assert.equal(ExtensionFromMIME("image/jpg"), ".jpg");
  assert.equal(ExtensionFromMIME("text/plain; charset=utf-8"), ".txt");
  assert.equal(ExtensionFromMIME("unknown/type"), ".bin");
});

test("image and video MIME helpers classify correctly", () => {
  assert.equal(isImageMIME("image/png"), true);
  assert.equal(isImageMIME("video/mp4"), false);
  assert.equal(isVideoMIME("video/mp4"), true);
  assert.equal(isVideoMIME("application/pdf"), false);
});
