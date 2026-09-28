import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { SecureSession } from "../lib/secure-session.ts";
import { createInvite, inviteHash, parseInvite, randomPeerId, randomToken, ROOM_TTL_MS, MAX_MESSAGES, MAX_FRAME_CHARS } from "../lib/protocol.ts";
import { deriveTrafficKeys, makeProof, verifyProof, seal, unseal } from "../lib/crypto.ts";
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > end) assert.fail("Protocol did not settle"); await delay(1); }
}
function pair(options = {}) {
  const clock = { wall: 1800000000000, mono: 0 };
  const invite = createInvite(clock.wall); const guestId = randomPeerId();
  const result = { clock, invite, hostMessages: [], guestMessages: [], delivered: [], unconfirmed: [], closed: [], trace: [], blockHost: false, blockGuest: false };
  let host, guest;
  const base = { now: () => clock.wall, monotonic: () => clock.mono, invite, onReady() {}, onDelivered: id => result.delivered.push(id), onUnconfirmed: id => result.unconfirmed.push(id), closeWire() {} };
  host = new SecureSession({ ...base, role: "host", localId: invite.hostId, remoteId: guestId, nickname: "호스트", onMessage: m => result.hostMessages.push(m), onClose: reason => result.closed.push(["host", reason]), send: raw => { result.trace.push(["host", raw]); if (!result.blockHost) queueMicrotask(() => void guest.receive(raw)); }, ...options.host });
  guest = new SecureSession({ ...base, role: "guest", localId: guestId, remoteId: invite.hostId, nickname: "손님", invite: { ...invite, ...options.guestInvite }, onMessage: m => result.guestMessages.push(m), onClose: reason => result.closed.push(["guest", reason]), send: raw => { result.trace.push(["guest", raw]); if (!result.blockGuest) queueMicrotask(() => void host.receive(raw)); }, ...options.guest });
  result.host = host; result.guest = guest;
  guest.start(); host.start(); return result;
}
async function ready(p) { await until(() => p.host.ready && p.guest.ready); }

test("invite is fragment-only, strict, bounded and expires at nine hours", () => {
  const now = 1800000000000, invite = createInvite(now), hash = inviteHash(invite);
  assert.equal(invite.expiresAt, now + ROOM_TTL_MS); assert.deepEqual(parseInvite(hash, now), invite);
  assert.equal(new URL(`https://example.com/one-chat/${hash}`).search, "");
  assert.throws(() => parseInvite(hash + "&key=" + randomToken(), now));
  assert.throws(() => parseInvite(hash, invite.expiresAt), /ROOM_EXPIRED/);
  assert.throws(() => parseInvite(hash.replace("v=2", "v=1"), now));
});
test("mutual proofs bind peer IDs, expiry, both challenges and roles", async () => {
  const invite = createInvite(); const transcript = { hostId: invite.hostId, guestId: randomPeerId(), expiresAt: invite.expiresAt, hostChallenge: randomToken(), guestChallenge: randomToken() };
  const proof = await makeProof(invite, transcript, "host");
  assert.equal(await verifyProof(invite, transcript, "host", proof), true);
  assert.equal(await verifyProof(invite, transcript, "guest", proof), false);
  for (const field of ["hostId", "guestId", "expiresAt", "hostChallenge", "guestChallenge"]) {
    const changed = { ...transcript, [field]: field === "expiresAt" ? transcript.expiresAt + 1 : randomToken() };
    assert.equal(await verifyProof(invite, changed, "host", proof), false);
  }
});
test("directional and fresh-session keys reject reflection, wrong sequence and old ciphertext", async () => {
  const invite = createInvite(); const transcript = { hostId: invite.hostId, guestId: randomPeerId(), expiresAt: invite.expiresAt, hostChallenge: randomToken(), guestChallenge: randomToken() };
  const host = await deriveTrafficKeys(invite, transcript, "host"), guest = await deriveTrafficKeys(invite, transcript, "guest");
  const cipher = await seal(host, 1, { type: "ready", nickname: "hello" });
  assert.deepEqual(await unseal(guest, 1, cipher), { type: "ready", nickname: "hello" });
  await assert.rejects(unseal(host, 1, cipher)); await assert.rejects(unseal(guest, 2, cipher));
  const fresh = await deriveTrafficKeys(invite, { ...transcript, guestChallenge: randomToken() }, "guest");
  await assert.rejects(unseal(fresh, 1, cipher));
  await assert.rejects(unseal(guest, 1, cipher.slice(0, -4) + "AAAA"));
});
test("pair authenticates, encrypts nickname and messages, and acknowledges delivery", async () => {
  const p = pair(); await ready(p);
  await p.host.sendMessage("비밀 이야기 🦫"); await until(() => p.delivered.length === 1);
  assert.equal(p.guestMessages[0].text, "비밀 이야기 🦫"); assert.equal(p.guestMessages[0].nickname, "호스트");
  assert.equal(p.hostMessages[0].delivered, false); assert.equal(p.delivered[0], p.hostMessages[0].id);
  const wire = JSON.stringify(p.trace); for (const secret of [p.invite.key, "호스트", "손님", "비밀 이야기"]) assert.equal(wire.includes(secret), false);
});
test("wrong invitation key never authenticates or reveals the nickname", async () => {
  const p = pair({ guestInvite: { key: randomToken() } });
  await until(() => p.closed.length > 0); assert.equal(p.host.ready, false); assert.equal(p.guest.ready, false);
  assert.equal(p.hostMessages.length + p.guestMessages.length, 0);
  assert.equal(JSON.stringify(p.trace).includes("손님"), false);
});
test("concurrent bidirectional sends keep sequences and delivery acknowledgements ordered", async () => {
  const p = pair(); await ready(p);
  await Promise.all(Array.from({ length: 20 }, (_, i) => i % 2 ? p.host.sendMessage(`h${i}`) : p.guest.sendMessage(`g${i}`)));
  await until(() => p.delivered.length === 20);
  assert.equal(p.hostMessages.length, 20); assert.equal(p.guestMessages.length, 20); assert.deepEqual(p.closed, []);
  for (const side of ["host", "guest"]) {
    const sequence = p.trace.filter(([from]) => from === side).map(([, raw]) => JSON.parse(raw)).filter(f => f.type === "box").map(f => f.sequence);
    assert.deepEqual(sequence, sequence.map((_, i) => i + 1));
  }
});
test("replayed encrypted frame ends the session instead of duplicating a message", async () => {
  const p = pair(); await ready(p); await p.host.sendMessage("one"); await until(() => p.delivered.length === 1);
  const raw = p.trace.find(([from, raw]) => from === "host" && JSON.parse(raw).type === "box" && JSON.parse(raw).sequence === 2)[1];
  await p.guest.receive(raw); assert.equal(p.guest.ended, true); assert.equal(p.guestMessages.length, 1);
});
test("receipt timeout means unconfirmed, never read; a missing receipt is not delivery", async () => {
  const p = pair(); await ready(p); p.blockGuest = true;
  await p.host.sendMessage("pending"); await until(() => p.guestMessages.length === 1);
  assert.equal(p.delivered.length, 0); p.clock.mono += 15000; p.host.tick();
  assert.deepEqual(p.unconfirmed, [p.hostMessages[0].id]); assert.equal(p.host.ready, true);
});
test("wall-clock and monotonic deadlines both enforce expiration, including after clock rollback", async () => {
  for (const mode of ["wall", "mono"]) {
    const p = pair(); await ready(p);
    if (mode === "wall") p.clock.wall += ROOM_TTL_MS;
    else { p.clock.wall -= ROOM_TTL_MS; p.clock.mono += ROOM_TTL_MS; }
    await assert.rejects(p.host.sendMessage("too late")); assert.equal(p.host.ended, true);
    assert.deepEqual(p.closed[0], ["host", "ROOM_EXPIRED"]);
  }
});
test("closing during asynchronous encryption suppresses stale message frames", async () => {
  const p = pair(); await ready(p); const previous = p.trace.length;
  const sending = p.host.sendMessage("cancelled"); p.host.close(); await assert.rejects(sending);
  await delay(10); assert.equal(p.trace.length, previous); assert.equal(p.guestMessages.length, 0);
});
test("malformed and oversized frames terminate without processing chat content", async () => {
  for (const raw of [null, "{", "x".repeat(MAX_FRAME_CHARS + 1)]) {
    const p = pair(); await ready(p); await p.host.receive(raw); assert.equal(p.host.ended, true);
  }
});
test("handshake and idle connections have bounded lifetimes", async () => {
  const p = pair(); await ready(p); p.clock.mono += 180000; p.host.tick(); assert.equal(p.host.ended, true);
  const q = pair({ host: { send() {} } }); q.clock.mono = 15000; q.host.tick(); assert.equal(q.host.ended, true);
});
test("simultaneous final sends respect separate directional limits", async () => {
  const p = pair(); await ready(p);
  // Exercise the limit boundary without performing thousands of equivalent crypto operations.
  p.host.sentCount = MAX_MESSAGES - 1; p.host.receivedCount = MAX_MESSAGES - 1;
  p.guest.sentCount = MAX_MESSAGES - 1; p.guest.receivedCount = MAX_MESSAGES - 1;
  await Promise.all([p.host.sendMessage("last host"), p.guest.sendMessage("last guest")]); await until(() => p.delivered.length === 2);
  assert.equal(p.host.ready && p.guest.ready, true); await assert.rejects(p.host.sendMessage("over limit"), /MESSAGE_LIMIT/);
});
test("transport close failure still reports session closure", () => {
  let reason;
  const invite = createInvite(); const session = new SecureSession({ invite, role: "host", localId: invite.hostId, remoteId: randomPeerId(), nickname: "n", send() {}, closeWire() { throw new Error("wire"); }, onReady() {}, onMessage() {}, onDelivered() {}, onUnconfirmed() {}, onClose: r => { reason = r; } });
  assert.throws(() => session.close(), /wire/); assert.equal(reason, "DISCONNECTED"); assert.equal(session.ended, true);
});

test("a valid late receipt updates a previously unconfirmed message", async () => {
  const p = pair(); await ready(p); p.blockGuest = true;
  await p.host.sendMessage("delayed receipt"); await until(() => p.trace.some(([from, raw]) => from === "guest" && JSON.parse(raw).type === "box" && JSON.parse(raw).sequence === 2));
  const ack = p.trace.find(([from, raw]) => from === "guest" && JSON.parse(raw).type === "box" && JSON.parse(raw).sequence === 2)[1];
  p.clock.mono = 15000; p.host.tick(); assert.equal(p.unconfirmed.length, 1);
  await p.host.receive(ack); assert.deepEqual(p.delivered, [p.hostMessages[0].id]);
});
test("authentication timeout starts when the data channel becomes usable", async () => {
  let mono = 0; const invite = createInvite(); let reason;
  const session = new SecureSession({ invite, role: "guest", localId: randomPeerId(), remoteId: invite.hostId, nickname: "n", monotonic: () => mono, send() {}, closeWire() {}, onReady() {}, onMessage() {}, onDelivered() {}, onUnconfirmed() {}, onClose: r => { reason = r; } });
  mono = 20000; session.start(); session.tick(); assert.equal(session.ended, false);
  mono = 35000; session.tick(); assert.equal(reason, "AUTH_TIMEOUT");
});
