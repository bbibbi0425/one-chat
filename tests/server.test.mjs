import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.mjs";
import { cleanupExpired } from "../lib/server.ts";
import { ROOM_TTL_MS, randomToken } from "../lib/protocol.ts";
import { encryptMessage, importRoomKey } from "../lib/crypto.ts";

async function envelope(session, text = "서버에 평문으로 남지 않을 대화") {
  return encryptMessage(await importRoomKey(randomToken()), session.room.id, session.senderId, { nickname: "지민", text });
}

test("room TTL is fixed at creation, credentials hashed, cross-room access denied", async t => {
  const f = fixture(); t.after(f.close);
  const a = await f.create(); const b = await f.create();
  assert.equal(a.room.expiresAt - a.room.createdAt, ROOM_TTL_MS);
  const roomRow = f.sqlite.prepare("SELECT * FROM rooms WHERE id = ?").get(a.room.id);
  assert.notEqual(roomRow.invite_hash, a.inviteToken);
  assert.notEqual(f.sqlite.prepare("SELECT * FROM members WHERE id = ?").get(a.senderId).token_hash, a.sessionToken);
  for (const token of [randomToken(), b.sessionToken, a.inviteToken]) {
    assert.equal((await f.request(`/api/rooms/${a.room.id}/messages`, token)).status, 403);
    assert.equal((await f.request(`/api/rooms/${a.room.id}/messages`, token, await envelope(a))).status, 403);
  }
  assert.equal((await f.request(`/api/rooms/${a.room.id}/messages`)).status, 401);
  assert.equal((await f.request(`/api/rooms/${a.room.id}/join`, b.inviteToken, {})).status, 403);
  assert.equal((await f.request(`/api/rooms/${a.room.id}/messages`, a.sessionToken)).headers.get("cache-control"), "no-store");
});

test("persist ciphertext, idempotent concurrent retries, conflict and nonce protection", async t => {
  const f = fixture(); t.after(f.close);
  const a = await f.create(); const msg = await envelope(a);
  const path = `/api/rooms/${a.room.id}/messages`;
  const responses = await Promise.all(Array.from({ length: 10 }, () => f.request(path, a.sessionToken, msg)));
  assert.ok(responses.every(r => [200, 201].includes(r.status)));
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 1);
  assert.equal((await f.request(path, a.sessionToken, { ...msg, ciphertext: (await envelope(a)).ciphertext })).status, 409);
  assert.equal((await f.request(path, a.sessionToken, { ...msg, id: crypto.randomUUID() })).status, 409);
  const stored = f.sqlite.prepare("SELECT * FROM messages").get();
  assert.equal(stored.ciphertext, msg.ciphertext);
  assert.equal(JSON.stringify(stored).includes("지민"), false);
  assert.equal(JSON.stringify(stored).includes("서버에 평문"), false);
  const joinedAgain = await (await f.request(`/api/rooms/${a.room.id}/join`, a.inviteToken, {})).json();
  const history = await (await f.request(path, joinedAgain.sessionToken)).json();
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].id, msg.id);
  assert.equal(joinedAgain.room.expiresAt, a.room.expiresAt);
});

test("exact 9h boundary blocks an existing session and cascades cleanup", async t => {
  const f = fixture(); t.after(f.close);
  const a = await f.create(); const path = `/api/rooms/${a.room.id}/messages`;
  f.clock.now = a.room.expiresAt - 1;
  assert.equal((await f.request(path, a.sessionToken, await envelope(a))).status, 201);
  assert.equal((await f.request(path, a.sessionToken)).status, 200);
  f.clock.now = a.room.expiresAt;
  assert.equal((await f.request(path, a.sessionToken)).status, 410);
  assert.equal((await f.request(path, a.sessionToken, await envelope(a))).status, 403);
  assert.equal((await f.request(`/api/rooms/${a.room.id}/join`, a.inviteToken, {})).status, 403);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM members").get().n, 0);
});

test("expiry inside delayed INSERT cannot save a new message", async t => {
  const f = fixture(); t.after(f.close);
  const a = await f.create(); f.clock.now = a.room.expiresAt - 1000;
  f.db.before = sql => { if (sql.includes("INSERT INTO messages")) f.clock.now = a.room.expiresAt; };
  assert.equal((await f.request(`/api/rooms/${a.room.id}/messages`, a.sessionToken, await envelope(a))).status, 410);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM messages").get().n, 0);
});

test("idle-room cleanup removes expired rooms only", async t => {
  const f = fixture(); t.after(f.close);
  const a = await f.create(); f.clock.now += 60000; const b = await f.create();
  f.clock.now = a.room.expiresAt;
  await cleanupExpired(f.db);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM rooms").get().n, 1);
  assert.equal((await f.request(`/api/rooms/${b.room.id}/messages`, b.sessionToken)).status, 200);
});

test("cross-origin requests, malformed cursor/body and large payloads rejected", async t => {
  const f = fixture(); t.after(f.close); const a = await f.create();
  const path = `/api/rooms/${a.room.id}/messages`;
  assert.equal((await f.request(path, a.sessionToken, await envelope(a), { headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await f.request(path + "?after=-1", a.sessionToken)).status, 400);
  assert.equal((await f.request(path, a.sessionToken, { id: "bad" })).status, 400);
  assert.equal((await f.request(path, a.sessionToken, { value: "x".repeat(20001) })).status, 413);
});

test("failed joins from one IP do not consume another user's join allowance", async t => {
  const f = fixture(); t.after(f.close); const a = await f.create();
  const path = `/api/rooms/${a.room.id}/join`;
  for (let i = 0; i < 120; i++) await f.request(path, randomToken(), {}, { headers: { "CF-Connecting-IP": "192.0.2.1" } });
  assert.equal((await f.request(path, randomToken(), {}, { headers: { "CF-Connecting-IP": "192.0.2.1" } })).status, 429);
  assert.equal((await f.request(path, a.inviteToken, {}, { headers: { "CF-Connecting-IP": "192.0.2.2" } })).status, 201);
});


test("maximum accepted plaintext fits the encrypted API payload", async t => {
  const f = fixture(); t.after(f.close); const a = await f.create();
  const message = await encryptMessage(await importRoomKey(randomToken()), a.room.id, a.senderId, { nickname: "\u0001".repeat(20), text: "\u0001".repeat(2000) });
  assert.equal((await f.request(`/api/rooms/${a.room.id}/messages`, a.sessionToken, message)).status, 201);
});

test("full room returns a permanent error, not a retryable rate limit", async t => {
  const f = fixture(); t.after(f.close); const a = await f.create();
  const insert = f.sqlite.prepare("INSERT INTO messages (id, room_id, sender_id, iv, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < 2000; i++) insert.run(crypto.randomUUID(), a.room.id, a.senderId, `test-${i}`, "cipher", f.clock.now - 120000);
  const response = await f.request(`/api/rooms/${a.room.id}/messages`, a.sessionToken, await envelope(a));
  assert.equal(response.status, 409); assert.equal((await response.json()).error, "ROOM_FULL");
});
