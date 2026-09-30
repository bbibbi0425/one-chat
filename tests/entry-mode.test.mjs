import test from "node:test";
import assert from "node:assert/strict";
import { deriveOpenRoom, prepareRoomEntry } from "../lib/entry-mode.ts";
import { createRoomCode, deriveCodeRoom } from "../lib/code-room.ts";
import { createInvite, ROOM_TTL_MS, PEER_ID, validSecret } from "../lib/protocol.ts";
const base = "https://example.github.io/one-chat/";

test("open entry shares the base address across normal, notes and popup windows", async () => {
  const expected = await deriveOpenRoom(base);
  for (const suffix of ["?window=compact&theme=notes&font=16", "index.html?entry=open", "#ignored"]) {
    assert.deepEqual(await deriveOpenRoom(base + suffix), expected);
  }
  assert.deepEqual(await deriveOpenRoom(base.slice(0, -1)), expected);
  assert.notDeepEqual(await deriveOpenRoom("http://127.0.0.1:5173/"), expected);
  assert.notDeepEqual(await deriveOpenRoom("https://example.github.io/another/"), expected);
  assert.ok(PEER_ID.test(expected.hostId) && PEER_ID.test(expected.guestId));
  assert.notEqual(expected.hostId, expected.guestId); assert.ok(validSecret(expected.key));
});

test("switching to open entry ignores stale codes while code entry still requires a valid code", async () => {
  const now = Date.now(), code = createRoomCode();
  const open = await prepareRoomEntry("open", "stale invalid code", base, null, now);
  assert.equal(open.mode, "open"); assert.equal(open.code, ""); assert.equal(open.role, "host");
  assert.equal(open.invite.expiresAt, now + ROOM_TTL_MS);
  const coded = await prepareRoomEntry("code", code.toLowerCase(), base, null, now);
  const fixed = await deriveCodeRoom(code);
  assert.equal(coded.mode, "code"); assert.equal(coded.code, code);
  assert.equal(coded.invite.hostId, fixed.hostId); assert.equal(coded.fixedGuestId, fixed.guestId);
  assert.notEqual(coded.invite.hostId, open.invite.hostId);
  assert.notEqual(coded.invite.key, open.invite.key);
  await assert.rejects(prepareRoomEntry("code", "", base), /INVALID_ROOM_CODE/);
  await assert.rejects(prepareRoomEntry("code", "bad", base), /INVALID_ROOM_CODE/);
});

test("legacy invitations remain guest entries and expired invitations never fall into the public room", async () => {
  const now = Date.now(), invite = createInvite(now);
  const entry = await prepareRoomEntry("open", "", base, invite, now);
  assert.equal(entry.mode, "invite"); assert.equal(entry.role, "guest");
  assert.deepEqual(entry.invite, invite); assert.notEqual(entry.invite, invite);
  assert.equal(entry.fixedGuestId, undefined);
  await assert.rejects(prepareRoomEntry("open", "", base, invite, invite.expiresAt), /ROOM_EXPIRED/);
});
