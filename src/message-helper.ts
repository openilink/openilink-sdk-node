import { ITEM_TYPE_FILE, ITEM_TYPE_IMAGE, ITEM_TYPE_TEXT, ITEM_TYPE_VIDEO, ITEM_TYPE_VOICE } from "./constants.js";
import type { MessageItem, WeixinMessage } from "./types.js";

export function isMediaItem(item: MessageItem | undefined): boolean {
  if (!item) {
    return false;
  }

  return (
    item.type === ITEM_TYPE_IMAGE ||
    item.type === ITEM_TYPE_VIDEO ||
    item.type === ITEM_TYPE_FILE ||
    item.type === ITEM_TYPE_VOICE
  );
}

export function extractText(message: WeixinMessage): string {
  for (const item of message.item_list ?? []) {
    if (item.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === "string") {
      let text = item.text_item.text;
      const ref = item.ref_msg;

      if (ref?.message_item && !isMediaItem(ref.message_item)) {
        const refBody = typeof ref.message_item.text_item?.text === "string" ? ref.message_item.text_item.text : "";
        const title = typeof ref.title === "string" ? ref.title : "";

        if (title !== "" || refBody !== "") {
          text = `[引用: ${title} | ${refBody}]\n${text}`;
        }
      }

      return text;
    }
  }

  for (const item of message.item_list ?? []) {
    if (item.type === ITEM_TYPE_VOICE && typeof item.voice_item?.text === "string" && item.voice_item.text !== "") {
      return item.voice_item.text;
    }
  }

  return "";
}
