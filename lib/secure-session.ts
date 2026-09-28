import { deriveTrafficKeys, makeProof, seal, unseal, verifyProof } from "./crypto.ts";
import type { TrafficKeys, Transcript } from "./crypto.ts";
import { MAX_FRAME_CHARS, MAX_MESSAGES, PEER_ID, parseFrame, randomToken, ROOM_TTL_MS, validateNickname, validatePayload } from "./protocol.ts";
import type { ChatMessage, Frame, Invite, Payload, Role } from "./protocol.ts";
export interface SessionOptions {
  invite: Invite; role: Role; localId: string; remoteId: string; nickname: string;
  send(data: string): void; closeWire(): void;
  onReady(nickname: string): void; onMessage(message: ChatMessage): void;
  onDelivered(id: string): void; onUnconfirmed(id: string): void; onClose(reason: string): void;
  now?: () => number; monotonic?: () => number; deadline?: number;
}
export class SecureSession {
  private options: SessionOptions;
  private now: () => number;
  private mono: () => number;
  private deadline: number;
  private started: number;
  private lastReceived: number;
  private lastPing: number;
  private state = "new";
  private hostChallenge = "";
  private guestChallenge = "";
  private keys?: TrafficKeys;
  private remoteNickname = "";
  private sendSequence = 0;
  private receiveSequence = 0;
  private receivedIds = new Set<string>();
  private pending = new Map<string, number>();
  private unconfirmed = new Set<string>();
  private sentCount = 0;
  private receivedCount = 0;
  private queuedFrames = 0;
  private receiveQueue = Promise.resolve();
  private sendQueue = Promise.resolve();
  private closed = false;
  constructor(options: SessionOptions) {
    this.options = { ...options, invite: { ...options.invite }, nickname: validateNickname(options.nickname) };
    this.now = options.now ?? Date.now; this.mono = options.monotonic ?? (() => performance.now());
    this.started = this.lastReceived = this.lastPing = this.mono();
    this.deadline = Math.min(options.deadline ?? Infinity, this.started + Math.min(ROOM_TTL_MS, Math.max(0, options.invite.expiresAt - this.now())));
    if (options.role === "host" ? options.localId !== options.invite.hostId : options.remoteId !== options.invite.hostId) throw new Error("WRONG_PEER");
    if (!PEER_ID.test(options.localId) || !PEER_ID.test(options.remoteId) || options.localId === options.remoteId) throw new Error("WRONG_PEER");
  }
  get ready() { return !this.closed && this.state === "ready"; }
  get ended() { return this.closed; }
  private alive() {
    if (this.closed) return false;
    if (this.now() >= this.options.invite.expiresAt || this.mono() >= this.deadline) { this.close("ROOM_EXPIRED"); return false; }
    return true;
  }
  private transcript(): Transcript {
    return { hostId: this.options.invite.hostId, guestId: this.options.role === "host" ? this.options.remoteId : this.options.localId,
      expiresAt: this.options.invite.expiresAt, hostChallenge: this.hostChallenge, guestChallenge: this.guestChallenge };
  }
  private sendRaw(frame: Frame) { if (this.alive()) this.options.send(JSON.stringify(frame)); }
  start() {
    if (this.state !== "new" || !this.alive()) return;
    this.started = this.lastReceived = this.lastPing = this.mono();
    if (this.options.role === "host") {
      this.hostChallenge = randomToken(); this.state = "guest-proof";
      this.sendRaw({ version: 2, type: "hello", challenge: this.hostChallenge });
    } else this.state = "hello";
  }
  receive(raw: unknown): Promise<void> {
    if (!this.alive()) return Promise.resolve();
    if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) { this.close("INVALID_FRAME"); return Promise.resolve(); }
    if (++this.queuedFrames > 32) { this.close("INVALID_FRAME"); return Promise.resolve(); }
    this.receiveQueue = this.receiveQueue.then(async () => {
      if (!this.alive()) return;
      await this.handle(parseFrame(raw));
      if (this.alive()) this.lastReceived = this.mono();
    }).catch(() => this.close("AUTH_FAILED")).finally(() => { this.queuedFrames--; });
    return this.receiveQueue;
  }
  private async handle(frame: Frame) {
    if (this.state === "hello" && frame.type === "hello") {
      this.hostChallenge = frame.challenge; this.guestChallenge = randomToken();
      const proof = await makeProof(this.options.invite, this.transcript(), "guest");
      if (!this.alive()) return;
      this.state = "host-proof";
      this.sendRaw({ version: 2, type: "proof", challenge: this.guestChallenge, proof }); return;
    }
    if (this.state === "guest-proof" && frame.type === "proof" && frame.challenge) {
      this.guestChallenge = frame.challenge;
      if (!await verifyProof(this.options.invite, this.transcript(), "guest", frame.proof)) throw new Error("AUTH_FAILED");
      if (!this.alive()) return;
      const keys = await deriveTrafficKeys(this.options.invite, this.transcript(), "host");
      const proof = await makeProof(this.options.invite, this.transcript(), "host");
      if (!this.alive()) return;
      this.keys = keys; this.state = "ready-proof";
      this.sendRaw({ version: 2, type: "proof", proof }); return;
    }
    if (this.state === "host-proof" && frame.type === "proof" && !frame.challenge) {
      if (!await verifyProof(this.options.invite, this.transcript(), "host", frame.proof)) throw new Error("AUTH_FAILED");
      if (!this.alive()) return;
      const keys = await deriveTrafficKeys(this.options.invite, this.transcript(), "guest");
      if (!this.alive()) return;
      this.keys = keys; this.state = "ready-proof";
      await this.sendBox({ type: "ready", nickname: this.options.nickname }); return;
    }
    if (frame.type !== "box" || !this.keys || frame.sequence !== this.receiveSequence + 1) throw new Error("INVALID_SEQUENCE");
    const payload = await unseal(this.keys, frame.sequence, frame.ciphertext);
    if (!this.alive()) return;
    this.receiveSequence = frame.sequence;
    if (this.state === "ready-proof" && payload.type === "ready") {
      this.remoteNickname = payload.nickname;
      if (this.options.role === "host") await this.sendBox({ type: "ready", nickname: this.options.nickname });
      if (!this.alive()) return;
      this.state = "ready"; this.options.onReady(this.remoteNickname); return;
    }
    if (!this.ready || payload.type === "ready") throw new Error("INVALID_STATE");
    if (payload.type === "message") {
      if (this.receivedIds.has(payload.id) || this.receivedCount >= MAX_MESSAGES) throw new Error("MESSAGE_LIMIT");
      this.receivedIds.add(payload.id); this.receivedCount++;
      this.options.onMessage({ id: payload.id, nickname: this.remoteNickname, text: payload.text, time: this.now(), mine: false, delivered: true });
      await this.sendBox({ type: "ack", id: payload.id });
    } else if (payload.type === "ack") {
      if (this.pending.delete(payload.id) || this.unconfirmed.delete(payload.id)) this.options.onDelivered(payload.id);
    } else if (payload.type === "ping") await this.sendBox({ type: "pong" });
  }
  private sendBox(payload: Payload): Promise<void> {
    const work = this.sendQueue.then(async () => {
      if (!this.alive() || !this.keys) throw new Error("DISCONNECTED");
      const sequence = ++this.sendSequence;
      const ciphertext = await seal(this.keys, sequence, payload);
      if (!this.alive()) throw new Error("DISCONNECTED");
      this.sendRaw({ version: 2, type: "box", sequence, ciphertext });
    });
    this.sendQueue = work.catch(() => this.close("DISCONNECTED"));
    return work;
  }
  async sendMessage(text: string): Promise<void> {
    if (!this.alive() || !this.ready) throw new Error("DISCONNECTED");
    if (this.sentCount >= MAX_MESSAGES || this.pending.size >= 64) throw new Error("MESSAGE_LIMIT");
    const id = crypto.randomUUID(); const payload = validatePayload({ type: "message", id, text });
    this.sentCount++; this.pending.set(id, this.mono());
    this.options.onMessage({ id, nickname: this.options.nickname, text, time: this.now(), mine: true, delivered: false });
    await this.sendBox(payload);
  }
  tick() {
    if (!this.alive()) return;
    const now = this.mono();
    if (!this.ready && now - this.started >= 15000) { this.close("AUTH_TIMEOUT"); return; }
    if (this.ready && now - this.lastReceived >= 180000) { this.close("DISCONNECTED"); return; }
    for (const [id, sentAt] of this.pending) if (now - sentAt >= 15000) { this.pending.delete(id); this.unconfirmed.add(id); this.options.onUnconfirmed(id); }
    if (this.ready && now - this.lastPing >= 15000) {
      this.lastPing = now; void this.sendBox({ type: "ping" }).catch(() => {});
    }
  }
  close(reason = "DISCONNECTED") {
    if (this.closed) return;
    this.closed = true; this.keys = undefined; this.hostChallenge = this.guestChallenge = this.remoteNickname = "";
    this.options.invite.key = ""; this.options.nickname = "";
    this.receivedIds.clear(); this.pending.clear(); this.unconfirmed.clear();
    try { this.options.closeWire(); } finally { this.options.onClose(reason); }
  }
}
