import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { PeerChat, PEER_OPTIONS } from "../lib/peer-chat.ts";
import { createInvite, randomToken, ROOM_TTL_MS } from "../lib/protocol.ts";
async function until(predicate) { const limit = Date.now() + 4000; while (!predicate()) { if (Date.now() > limit) assert.fail("Adapter did not settle"); await delay(1); } }
class Wire extends EventEmitter {
  constructor(peer) { super(); this.peer = peer; this.open = false; this.closed = false; this.serialization = "raw"; this.dataChannel = { bufferedAmount: 0 }; }
  send(data) { if (!this.open || this.closed) throw new Error("closed"); queueMicrotask(() => { if (!this.other.closed) this.other.emit("data", data); }); }
  close() { if (this.closed) return; this.closed = true; this.open = false; this.emit("close"); this.other?.close(); }
}
function network() {
  const peers = new Map(); const optionsSeen = []; const connects = [];
  class Peer extends EventEmitter {
    constructor(id, options) { super(); this.id = id; this.wires = []; peers.set(id, this); optionsSeen.push({ id, options }); queueMicrotask(() => this.emit("open", id)); }
    connect(id, options) {
      connects.push({ id, options }); const target = peers.get(id); const local = new Wire(id), remote = new Wire(this.id); local.other = remote; remote.other = local; this.wires.push(local); target?.wires.push(remote);
      queueMicrotask(() => {
        if (!target) { this.emit("error", { type: "peer-unavailable" }); return; }
        target.emit("connection", remote);
        if (!local.closed) { local.open = remote.open = true; local.emit("open"); remote.emit("open"); }
      }); return local;
    }
    destroy() { if (!peers.has(this.id)) return; peers.delete(this.id); for (const w of this.wires) w.close(); this.emit("close"); }
  }
  const chats = [];
  function participant(role, invite, extra = {}) {
    const state = { status: "preparing", messages: [], delivered: [], ended: [] };
    const chat = new PeerChat({ role, invite, nickname: role === "host" ? "private-host" : "private-guest", createPeer: (id, options) => new Peer(id, options), onStatus: s => { state.status = s; }, onMessage: m => state.messages.push(m), onDelivered: id => state.delivered.push(id), onUnconfirmed() {}, onEnd: r => { state.ended.push(r); state.messages = []; }, ...extra });
    chats.push(chat); chat.start(); return { chat, state };
  }
  return { peers, optionsSeen, connects, participant, close: () => chats.forEach(chat => chat.close()) };
}
test("two people connect; third participant is rejected without disturbing their chat", async t => {
  const n = network(); t.after(n.close); const invite = createInvite();
  const host = n.participant("host", invite), guest = n.participant("guest", invite); await until(() => host.state.status === "connected" && guest.state.status === "connected");
  const third = n.participant("guest", invite); await until(() => third.state.ended.length === 1);
  n.peers.get(invite.hostId).emit("error", { type: "webrtc" });
  await host.chat.send("still connected"); await until(() => guest.state.messages.length === 1);
  assert.equal(host.state.ended.length, 0); assert.equal(guest.state.ended.length, 0);
  const connectionData = JSON.stringify([n.optionsSeen, n.connects]);
  for (const secret of [invite.key, "private-host", "private-guest", "still connected"]) assert.equal(connectionData.includes(secret), false);
  assert.deepEqual(PEER_OPTIONS.config.iceServers, [{ urls: "stun:stun.l.google.com:19302" }]);
});
test("unauthenticated wrong-key guest cannot permanently occupy a waiting host", async t => {
  const n = network(); t.after(n.close); const invite = createInvite(), host = n.participant("host", invite);
  const wrong = n.participant("guest", { ...invite, key: randomToken() }); await until(() => wrong.state.ended.length === 1);
  assert.equal(host.state.status, "waiting"); const valid = n.participant("guest", invite); await until(() => valid.state.status === "connected"); assert.equal(host.state.status, "connected");
});
test("signaling disconnect does not close an authenticated peer channel", async t => {
  const n = network(); t.after(n.close); const invite = createInvite(), host = n.participant("host", invite), guest = n.participant("guest", invite);
  await until(() => guest.state.status === "connected"); n.peers.get(invite.hostId).emit("disconnected");
  await host.chat.send("RTC survives signaling"); await until(() => guest.state.messages.length === 1); assert.equal(host.state.ended.length, 0);
});
test("leaving closes both sides, clears view data and makes the old invite unavailable", async t => {
  const n = network(); t.after(n.close); const invite = createInvite(), host = n.participant("host", invite), guest = n.participant("guest", invite);
  await until(() => guest.state.status === "connected"); await host.chat.send("ephemeral"); await until(() => guest.state.messages.length === 1);
  guest.chat.close(); assert.equal(host.state.ended.length, 1); assert.equal(host.state.messages.length, 0); assert.equal(guest.state.messages.length, 0);
  assert.equal(n.peers.size, 0); const later = n.participant("guest", invite); await until(() => later.state.ended.length === 1); assert.equal(later.state.ended[0], "ROOM_UNAVAILABLE");
});
test("pending service connection and waiting host have bounded deadlines", t => {
  const n = network(); t.after(n.close); let mono = 0, wall = Date.now(); const invite = createInvite(wall);
  const { chat, state } = n.participant("host", invite, { now: () => wall, monotonic: () => mono });
  mono = 30000; chat.tick(); assert.deepEqual(state.ended, ["CONNECTION_TIMEOUT"]);
  const next = n.participant("host", invite, { now: () => wall, monotonic: () => mono });
  mono += ROOM_TTL_MS; wall -= ROOM_TTL_MS; next.chat.tick(); assert.deepEqual(next.state.ended, ["ROOM_EXPIRED"]);
});
test("oversized RTC buffers fail closed instead of accumulating unsent plaintext", async t => {
  const n = network(); t.after(n.close); const invite = createInvite(), host = n.participant("host", invite), guest = n.participant("guest", invite);
  await until(() => guest.state.status === "connected"); n.peers.get(invite.hostId).wires[0].dataChannel.bufferedAmount = 300000;
  await assert.rejects(host.chat.send("buffer full")); assert.equal(host.state.ended.length, 1); assert.equal(guest.state.ended.length, 1);
});
