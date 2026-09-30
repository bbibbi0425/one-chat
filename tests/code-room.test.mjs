import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createRoomCode, normalizeRoomCode, deriveCodeRoom } from "../lib/code-room.ts";
import { deriveOpenRoom } from "../lib/entry-mode.ts";
import { PeerChat } from "../lib/peer-chat.ts";
import { ROOM_TTL_MS, randomToken } from "../lib/protocol.ts";

async function until(predicate) {
  const limit = Date.now() + 4000;
  while (!predicate()) { if (Date.now() > limit) assert.fail("Code room did not settle"); await delay(1); }
}
function network({ delayGuestOpen = false, blockRtc = false, throwRtc = false, tamper } = {}) {
  const peers = new Map(), trace = [], registrations = [], connects = [], chats = [];
  const n = { peers, trace, registrations, connects, onConflict: undefined };
  class Wire extends EventEmitter {
    constructor(peer) { super(); this.peer = peer; this.open = false; this.closed = false; this.serialization = "raw"; this.dataChannel = { bufferedAmount: 0 }; }
    send(raw) { if (!this.open || this.closed) throw new Error("closed"); trace.push(raw); const payload = tamper ? tamper(raw) : raw; queueMicrotask(() => { if (!this.other.closed) this.other.emit("data", payload); }); }
    close() { if (this.closed) return; this.closed = true; this.open = false; this.emit("close"); this.other?.close(); }
  }
  class Peer extends EventEmitter {
    constructor(id, options) {
      super(); this.id = id; this.wires = []; this.destroyed = false; registrations.push({ id, options });
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (peers.has(id)) {
          n.onConflict?.(id);
          this.emit("error", { type: "unavailable-id" });
          // PeerJS emits cleanup events after the unavailable-id callback.
          this.emit("disconnected"); this.destroy(); return;
        }
        peers.set(id, this); this.emit("open", id);
      });
    }
    connect(id, options) {
      if (throwRtc) throw new Error("WebRTC disabled");
      connects.push({ id, options });
      const local = new Wire(id), remote = new Wire(this.id); local.other = remote; remote.other = local; this.wires.push(local);
      queueMicrotask(() => {
        const target = peers.get(id);
        if (!target) { if (!this.destroyed) this.emit("error", { type: "peer-unavailable" }); return; }
        target.wires.push(remote); target.emit("connection", remote);
        if (local.closed || blockRtc) return;
        remote.open = true;
        if (delayGuestOpen) { remote.emit("open"); queueMicrotask(() => { if (!local.closed) { local.open = true; local.emit("open"); } }); }
        else { local.open = true; local.emit("open"); remote.emit("open"); }
      });
      return local;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      if (peers.get(this.id) === this) peers.delete(this.id);
      this.emit("disconnected");
      for (const wire of this.wires) wire.close();
      this.emit("close");
    }
  }
  n.participant = (room, extra = {}) => {
    const now = extra.now ?? Date.now;
    const state = { status: "preparing", role: "host", expiresAt: null, messages: [], ended: [] };
    const invite = { version: 2, hostId: room.hostId, key: room.key, expiresAt: now() + ROOM_TTL_MS };
    const chat = new PeerChat({ role: "host", invite, fixedGuestId: room.guestId, nickname: "private-name", createPeer: (id, options) => new Peer(id, options),
      onStatus: status => { state.status = status; }, onRoom: (role, value) => { state.role = role; state.expiresAt = value.expiresAt; },
      onMessage: message => state.messages.push(message), onDelivered() {}, onUnconfirmed() {}, onEnd: reason => { state.ended.push(reason); state.messages = []; }, ...extra });
    chats.push(chat); chat.start(); return { chat, state };
  };
  n.close = () => chats.forEach(chat => chat.close());
  return n;
}

test("generated entry codes normalize consistently and derive separate identities and secret keys", async () => {
  const code = createRoomCode(), normalized = normalizeRoomCode(code);
  assert.equal(normalized.length, 20); assert.equal(code.split("-").length, 5);
  const room = await deriveCodeRoom(code);
  assert.deepEqual(await deriveCodeRoom(normalized.toLowerCase()), room);
  assert.notEqual(room.hostId, room.guestId);
  assert.notDeepEqual(await deriveCodeRoom(createRoomCode()), room);
  assert.throws(() => normalizeRoomCode("1234"), /INVALID_ROOM_CODE/);
  assert.throws(() => normalizeRoomCode("O".repeat(20)), /INVALID_ROOM_CODE/);
});
test("simultaneous entry elects host and guest, rejects a third and keeps secrets off signaling", async t => {
  const code = createRoomCode(), room = await deriveCodeRoom(code), n = network({ delayGuestOpen: true }); t.after(n.close);
  const first = n.participant(room), second = n.participant(room);
  await until(() => first.state.status === "connected" && second.state.status === "connected");
  assert.deepEqual([first.state.role, second.state.role].sort(), ["guest", "host"]);
  assert.equal(n.peers.size, 2);
  const third = n.participant(room); await until(() => third.state.ended.length);
  assert.deepEqual(third.state.ended, ["ROOM_FULL"]); assert.equal(n.peers.size, 2);
  await first.chat.send("private-message"); await until(() => second.state.messages.length === 1);
  assert.equal(first.state.ended.length + second.state.ended.length, 0);
  const publicData = JSON.stringify([n.registrations, n.connects, n.trace]);
  for (const secret of [code, normalizeRoomCode(code), room.key, "private-name", "private-message"]) assert.equal(publicData.includes(secret), false);
});
test("later entry uses the host deadline instead of extending the room by nine hours", async t => {
  const room = await deriveCodeRoom(createRoomCode()), n = network(); t.after(n.close);
  let wall = Date.now(), mono = 0;
  const options = { now: () => wall, monotonic: () => mono };
  const host = n.participant(room, options); await until(() => host.state.status === "waiting");
  const expiresAt = host.state.expiresAt;
  wall += 60 * 60 * 1000; mono += 60 * 60 * 1000;
  const guest = n.participant(room, options); await until(() => guest.state.status === "connected");
  assert.equal(guest.state.expiresAt, expiresAt); assert.equal(guest.chat.remaining, host.chat.remaining);
  wall = expiresAt; mono = ROOM_TTL_MS; host.chat.tick();
  assert.deepEqual(host.state.ended, ["ROOM_EXPIRED"]); assert.equal(guest.state.ended.length, 1);
});
test("different entry codes remain in separate rooms", async t => {
  const n = network(); t.after(n.close);
  const first = n.participant(await deriveCodeRoom(createRoomCode())), second = n.participant(await deriveCodeRoom(createRoomCode()));
  await until(() => first.state.status === "waiting" && second.state.status === "waiting");
  assert.equal(n.connects.length, 0); assert.equal(n.peers.size, 2);
});
test("a wrong derived key cannot expose nicknames or lock out the next valid guest", async t => {
  const room = await deriveCodeRoom(createRoomCode()), n = network(); t.after(n.close);
  const host = n.participant(room); await until(() => host.state.status === "waiting");
  const wrong = n.participant({ ...room, key: randomToken() }); await until(() => wrong.state.ended.length);
  assert.equal(wrong.state.status === "connected", false); assert.equal(host.state.status, "waiting");
  assert.equal(JSON.stringify(n.trace).includes("private-name"), false);
  const guest = n.participant(room); await until(() => guest.state.status === "connected");
  await host.chat.send("works"); await until(() => guest.state.messages.length === 1);
});
test("lost signaling releases both reserved slots and the same code starts a fresh session", async t => {
  const room = await deriveCodeRoom(createRoomCode()), n = network(); t.after(n.close);
  const host = n.participant(room), guest = n.participant(room); await until(() => guest.state.status === "connected");
  await host.chat.send("old message"); await until(() => guest.state.messages.length === 1);
  const oldFrame = n.trace.find(raw => { const f = JSON.parse(raw); return f.type === "box" && f.sequence === 2; });
  n.peers.get(room.hostId).emit("disconnected");
  assert.deepEqual(host.state.ended, ["SIGNAL_UNAVAILABLE"]); assert.equal(guest.state.ended.length, 1); assert.equal(n.peers.size, 0);
  const nextHost = n.participant(room), nextGuest = n.participant(room); await until(() => nextGuest.state.status === "connected");
  n.peers.get(room.guestId).wires[0].emit("data", oldFrame);
  await until(() => nextGuest.state.ended.length);
  assert.equal(nextGuest.state.messages.length, 0); assert.equal(nextHost.state.ended.length, 1);
});
test("a host leaving during election lets the remaining participant become host", async t => {
  const room = await deriveCodeRoom(createRoomCode()), n = network(); t.after(n.close);
  const host = n.participant(room); await until(() => host.state.status === "waiting");
  n.onConflict = () => { n.onConflict = undefined; host.chat.close(); };
  const survivor = n.participant(room); await until(() => survivor.state.status === "waiting");
  assert.equal(survivor.state.role, "host"); assert.equal(survivor.state.ended.length, 0);
  const next = n.participant(room); await until(() => next.state.status === "connected");
});
test("direct connection timeout is distinguished from signaling and authentication failure", async t => {
  const room = await deriveCodeRoom(createRoomCode()), n = network({ blockRtc: true }); t.after(n.close);
  let mono = 0;
  const host = n.participant(room, { monotonic: () => mono }), guest = n.participant(room, { monotonic: () => mono });
  await until(() => n.connects.length === 1 && host.state.status === "connecting");
  mono = 30000; guest.chat.tick();
  assert.deepEqual(guest.state.ended, ["RTC_TIMEOUT"]); assert.equal(host.state.status, "waiting");
});
test("an invalid bootstrap expiry is rejected before nicknames or messages are shared", async t => {
  const room = await deriveCodeRoom(createRoomCode());
  const n = network({ tamper: raw => { const frame = JSON.parse(raw); return frame.type === "room" ? JSON.stringify({ ...frame, expiresAt: Date.now() + 2 * ROOM_TTL_MS }) : raw; } }); t.after(n.close);
  const host = n.participant(room), guest = n.participant(room); await until(() => guest.state.ended.length);
  assert.deepEqual(guest.state.ended, ["AUTH_FAILED"]); assert.equal(host.state.status, "waiting");
  assert.equal(n.trace.some(raw => JSON.parse(raw).type === "box"), false);
});

test("a browser refusing RTC creation produces a visible failure and releases its slot", async t => {
  const room = await deriveCodeRoom(createRoomCode()), n = network({ throwRtc: true }); t.after(n.close);
  const host = n.participant(room), guest = n.participant(room);
  await until(() => guest.state.ended.length);
  assert.deepEqual(guest.state.ended, ["RTC_UNAVAILABLE"]); assert.equal(host.state.status, "waiting");
  assert.equal(n.peers.size, 1);
});

test("base-address participants pair in the shared room, reject a third and stay separate from code rooms", async t => {
  const n = network(); t.after(n.close);
  const address = "https://example.github.io/one-chat/";
  const room = await deriveOpenRoom(address);
  const first = n.participant(room), second = n.participant(await deriveOpenRoom(address + "?window=compact&theme=notes"));
  const coded = n.participant(await deriveCodeRoom(createRoomCode()));
  await until(() => first.state.status === "connected" && second.state.status === "connected" && coded.state.status === "waiting");
  const third = n.participant(room); await until(() => third.state.ended.length);
  assert.deepEqual(third.state.ended, ["ROOM_FULL"]);
  await first.chat.send("shared room"); await until(() => second.state.messages.length === 1);
  assert.equal(coded.state.messages.length, 0);
  first.chat.close(); assert.equal(second.state.ended.length, 1);
  const next = n.participant(await deriveOpenRoom(address));
  await until(() => next.state.status === "waiting");
  const partner = n.participant(room); await until(() => partner.state.status === "connected");
  assert.equal(next.state.messages.length, 0); assert.equal(partner.state.messages.length, 0);
});
