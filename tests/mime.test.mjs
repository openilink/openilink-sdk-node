import test from "node:test";
import assert from "node:assert/strict";

import { ExtensionFromMIME, MIMEFromFilename, isImageMIME, isVideoMIME } from "../dist/mime.js";

test("MIMEFromFilename resolves known extensions and falls back", () => {
  const cases = [
    ["photo.jpg", "image/jpeg"],
    ["photo.JPEG", "image/jpeg"],
    ["image.png", "image/png"],
    ["image.gif", "image/gif"],
    ["image.webp", "image/webp"],
    ["image.bmp", "image/bmp"],
    ["video.mp4", "video/mp4"],
    ["video.mov", "video/quicktime"],
    ["video.webm", "video/webm"],
    ["video.mkv", "video/x-matroska"],
    ["video.avi", "video/x-msvideo"],
    ["doc.pdf", "application/pdf"],
    ["doc.doc", "application/msword"],
    ["doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["audio.mp3", "audio/mpeg"],
    ["audio.wav", "audio/wav"],
    ["archive.zip", "application/zip"],
    ["data.csv", "text/csv"],
    ["notes.txt", "text/plain"],
    ["unknown.xyz", "application/octet-stream"],
    ["noext", "application/octet-stream"],
    ["", "application/octet-stream"],
  ];

  for (const [filename, expected] of cases) {
    assert.equal(MIMEFromFilename(filename), expected);
  }
});

test("ExtensionFromMIME resolves alias, strips parameters, and falls back", () => {
  const cases = [
    ["image/jpeg", ".jpg"],
    ["image/jpg", ".jpg"],
    ["image/png", ".png"],
    ["video/mp4", ".mp4"],
    ["application/pdf", ".pdf"],
    ["text/plain", ".txt"],
    ["text/plain; charset=utf-8", ".txt"],
    ["unknown/type", ".bin"],
    ["", ".bin"],
  ];

  for (const [mime, expected] of cases) {
    assert.equal(ExtensionFromMIME(mime), expected);
  }
});

test("image and video MIME helpers classify correctly", () => {
  assert.equal(isImageMIME("image/png"), true);
  assert.equal(isImageMIME("image/jpeg"), true);
  assert.equal(isImageMIME("video/mp4"), false);
  assert.equal(isImageMIME("application/pdf"), false);
  assert.equal(isVideoMIME("video/mp4"), true);
  assert.equal(isVideoMIME("video/webm"), true);
  assert.equal(isVideoMIME("application/pdf"), false);
  assert.equal(isVideoMIME("image/png"), false);
});
