import test from "node:test";
import assert from "node:assert/strict";

import {
  ITEM_TYPE_IMAGE,
  ITEM_TYPE_TEXT,
  ITEM_TYPE_VOICE,
} from "../dist/constants.js";
import { extractText, isMediaItem } from "../dist/message-helper.js";

test("extractText returns plain text content", () => {
  assert.equal(
    extractText({
      item_list: [
        {
          type: ITEM_TYPE_TEXT,
          text_item: { text: "hello" },
        },
      ],
    }),
    "hello",
  );
});

test("extractText prepends quoted text context but ignores media references", () => {
  assert.equal(
    extractText({
      item_list: [
        {
          type: ITEM_TYPE_TEXT,
          text_item: { text: "reply body" },
          ref_msg: {
            title: "原消息",
            message_item: {
              type: ITEM_TYPE_TEXT,
              text_item: { text: "quoted body" },
            },
          },
        },
      ],
    }),
    "[引用: 原消息 | quoted body]\nreply body",
  );

  assert.equal(
    extractText({
      item_list: [
        {
          type: ITEM_TYPE_TEXT,
          text_item: { text: "reply body" },
          ref_msg: {
            title: "图片",
            message_item: {
              type: ITEM_TYPE_IMAGE,
              image_item: { url: "https://example.invalid/image.jpg" },
            },
          },
        },
      ],
    }),
    "reply body",
  );
});

test("extractText falls back to voice transcription", () => {
  assert.equal(
    extractText({
      item_list: [
        {
          type: ITEM_TYPE_VOICE,
          voice_item: { text: "voice transcript" },
        },
      ],
    }),
    "voice transcript",
  );
});

test("extractText returns empty string for non-text messages and voice without transcript", () => {
  assert.equal(
    extractText({
      item_list: [
        {
          type: ITEM_TYPE_IMAGE,
          image_item: { url: "https://example.invalid/image.jpg" },
        },
      ],
    }),
    "",
  );

  assert.equal(
    extractText({
      item_list: [
        {
          type: ITEM_TYPE_VOICE,
          voice_item: {},
        },
      ],
    }),
    "",
  );
});

test("extractText prioritizes text items over earlier voice items", () => {
  assert.equal(
    extractText({
      item_list: [
        {
          type: ITEM_TYPE_VOICE,
          voice_item: { text: "voice transcript" },
        },
        {
          type: ITEM_TYPE_TEXT,
          text_item: { text: "preferred text" },
        },
      ],
    }),
    "preferred text",
  );
});

test("isMediaItem classifies media and non-media items", () => {
  assert.equal(isMediaItem({ type: ITEM_TYPE_IMAGE }), true);
  assert.equal(isMediaItem({ type: ITEM_TYPE_TEXT }), false);
  assert.equal(isMediaItem({ type: ITEM_TYPE_VOICE }), true);
  assert.equal(isMediaItem(undefined), false);
});
