import test from "node:test";
import assert from "node:assert/strict";
import { decryptMessage, encryptMessage, importRoomKey, inviteHash, parseInvite } from "../lib/crypto.ts";
import { randomToken, decode64, encode64 } from "../lib/protocol.ts";

test("link round trip keeps access token and independent key in fragment", () => {
  const invite = { roomId: crypto.randomUUID(), token: randomToken(), key: randomToken() };
  const url = new URL("https://one-chat.test/" + inviteHash(invite));
  assert.equal(url.search, ""); assert.equal(url.pathname, "/");
  assert.deepEqual(parseInvite(url.hash), invite);
  assert.throws(() => parseInvite("#room=bad"));
});

test("AES-GCM roundtrip, fresh nonce, wrong key and bound metadata tampering", async () => {
  const key = await importRoomKey(randomToken()); const room = crypto.randomUUID(); const sender = crypto.randomUUID();
  const plain = { nickname: "<script>me</script>", text: "안녕!\n<script>alert(1)</script>" };
  const a = await encryptMessage(key, room, sender, plain);
  const b = await encryptMessage(key, room, sender, plain);
  assert.notEqual(a.iv, b.iv);
  assert.deepEqual(await decryptMessage(key, room, sender, a), plain);
  await assert.rejects(decryptMessage(await importRoomKey(randomToken()), room, sender, a));
  await assert.rejects(decryptMessage(key, crypto.randomUUID(), sender, a));
  await assert.rejects(decryptMessage(key, room, crypto.randomUUID(), a));
  await assert.rejects(decryptMessage(key, room, sender, { ...a, id: crypto.randomUUID() }));
  const changed = decode64(a.ciphertext); changed[0] ^= 1;
  await assert.rejects(decryptMessage(key, room, sender, { ...a, ciphertext: encode64(changed) }));
});

test("reject malformed keys and empty or excessive plaintext", async () => {
  await assert.rejects(importRoomKey("bad"));
  const key = await importRoomKey(randomToken());
  for (const plain of [{ nickname: " ", text: "hi" }, { nickname: "a", text: " " }, { nickname: "a", text: "a".repeat(2001) }]) {
    await assert.rejects(encryptMessage(key, crypto.randomUUID(), crypto.randomUUID(), plain));
  }
});
