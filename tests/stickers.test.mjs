import test from "node:test";
import assert from "node:assert/strict";
import { STICKERS, getSticker, stickerMessage } from "../lib/stickers.ts";
import { MAX_MESSAGE_CHARS, validatePayload } from "../lib/protocol.ts";

test("only complete allowlisted sticker messages resolve to local assets", () => {
  const token = stickerMessage(STICKERS[0]);
  for (const text of ["안녕", "https://example.com/image.png", "__proto__", `${token} 뒤에 글`, ` ${token}`, token.replace("bo-dance-v1", "../../secret"), token.replace("bo-dance-v1", "bo-dance-v2"), token.replace("신남", "다른 표정")]) {
    assert.equal(getSticker(text), undefined);
  }
  for (const sticker of STICKERS) {
    assert.equal(getSticker(stickerMessage(sticker)), sticker);
    assert.match(sticker.file, /^bo-[a-z]+-v1\.png$/);
  }
});
test("sticker messages remain short ordinary text for existing protocol clients", () => {
  assert.equal(new Set(STICKERS.map(stickerMessage)).size, STICKERS.length);
  for (const sticker of STICKERS) {
    const text = stickerMessage(sticker), id = crypto.randomUUID();
    assert.ok(text.length < 100 && text.length < MAX_MESSAGE_CHARS);
    assert.deepEqual(validatePayload({ type: "message", id, text }), { type: "message", id, text });
    assert.ok(text.includes(sticker.label));
  }
});
