import { ITEM_TYPE_TEXT } from "./constants.js";
import type { WeixinMessage } from "./types.js";

export function extractText(message: WeixinMessage): string {
  for (const item of message.item_list ?? []) {
    if (item.type === ITEM_TYPE_TEXT && typeof item.text_item?.text === "string") {
      return item.text_item.text;
    }
  }

  return "";
}
