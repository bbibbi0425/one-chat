import test from "node:test";
import assert from "node:assert/strict";
import { createInvite, parseInvite } from "../lib/protocol.ts";
import { popupUrl, readWindowMode } from "../lib/window-mode.ts";

test("popup preserves a pending invite only in the fragment and keeps the Pages path", () => {
  const invite = createInvite();
  const url = new URL(popupUrl("https://example.github.io/one-chat/?unrelated=value#old-fragment", invite, true, 16));
  assert.equal(url.origin + url.pathname, "https://example.github.io/one-chat/");
  assert.equal(url.search, "?window=compact&theme=notes&font=16");
  assert.ok(!url.search.includes(invite.key) && !url.search.includes(invite.hostId));
  assert.deepEqual(parseInvite(url.hash), invite);
  assert.deepEqual(readWindowMode(url.search), { compact: true, noteMode: true, fontSize: 16 });
});

test("starting a fresh popup discards stale fragments and unrelated query values", () => {
  const url = new URL(popupUrl("http://127.0.0.1:5173/one-chat/?key=old-secret&theme=notes#old-invite", null, false));
  assert.equal(url.href, "http://127.0.0.1:5173/one-chat/?window=compact");
  assert.deepEqual(readWindowMode(url.search), { compact: true, noteMode: false, fontSize: 14 });
  assert.deepEqual(readWindowMode("?window=unknown&theme=unknown&font=999"), { compact: false, noteMode: false, fontSize: 14 });
});
