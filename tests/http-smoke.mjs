import assert from "node:assert/strict";
import { randomToken } from "../lib/protocol.ts";
import { encryptMessage, decryptMessage, importRoomKey } from "../lib/crypto.ts";
const base = new URL(process.argv[2] ?? "http://localhost:5173");
if (!["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("Local smoke test only");
async function call(path, token, body) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? "GET" : "POST",
    headers: { Origin: base.origin, Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `HTTP ${response.status}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
const invite = randomToken(); const key = await importRoomKey(randomToken());
const { room } = await call("/api/rooms", invite, {});
const a = await call(`/api/rooms/${room.id}/join`, invite, {});
const b = await call(`/api/rooms/${room.id}/join`, invite, {});
const path = `/api/rooms/${room.id}/messages`;
const envelope = await encryptMessage(key, room.id, a.senderId, { nickname: "테스트 A", text: "암호화 연결 확인" });
await call(path, a.sessionToken, envelope);
await call(path, a.sessionToken, envelope);
const history = await call(path + "?after=0", b.sessionToken);
assert.equal(history.messages.length, 1);
assert.deepEqual(await decryptMessage(key, room.id, a.senderId, history.messages[0]), { nickname: "테스트 A", text: "암호화 연결 확인" });
const reply = await encryptMessage(key, room.id, b.senderId, { nickname: "테스트 B", text: "답장 확인" });
await call(path, b.sessionToken, reply);
const next = await call(path + `?after=${history.messages[0].sequence}`, a.sessionToken);
assert.equal(next.messages.length, 1);
assert.equal((await decryptMessage(key, room.id, b.senderId, next.messages[0])).text, "답장 확인");
console.log("PASS: local Worker/D1, two participants, encrypted roundtrip, retry deduplication and cursor history");
