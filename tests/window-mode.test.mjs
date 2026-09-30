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
  assert.deepEqual(readWindowMode(url.search), { entryMode: "open", compact: true, noteMode: true, fontSize: 16 });
});

test("starting a fresh popup discards stale fragments and unrelated query values", () => {
  const url = new URL(popupUrl("http://127.0.0.1:5173/one-chat/?key=old-secret&theme=notes#old-invite", null, false));
  assert.equal(url.href, "http://127.0.0.1:5173/one-chat/?window=compact");
  assert.deepEqual(readWindowMode(url.search), { entryMode: "open", compact: true, noteMode: false, fontSize: 14 });
  assert.deepEqual(readWindowMode("?window=unknown&theme=unknown&font=999"), { entryMode: "open", compact: false, noteMode: false, fontSize: 14 });
});

test("a new popup preserves the selected entry mode without carrying a room code", () => {
  const url = new URL(popupUrl("https://example.github.io/one-chat/?code=secret#stale", null, true, 16, "code"));
  assert.equal(readWindowMode(url.search).entryMode, "code");
  assert.equal(url.hash, ""); assert.equal(url.href.includes("secret"), false);
  assert.equal(readWindowMode("").entryMode, "open");
  assert.equal(readWindowMode("?entry=unknown").entryMode, "open");
  const open = new URL(popupUrl(url.href, null, false, 14, "open"));
  assert.equal(readWindowMode(open.search).entryMode, "open");
  assert.equal(open.searchParams.has("entry"), false);
});
