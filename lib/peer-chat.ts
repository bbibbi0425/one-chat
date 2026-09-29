import { SecureSession } from "./secure-session.ts";
import { MAX_FRAME_CHARS, PEER_ID, ROOM_TTL_MS, randomPeerId, validateNickname } from "./protocol.ts";
import type { ChatMessage, Invite, Role } from "./protocol.ts";

// Narrow, injectable interfaces let protocol tests run without a browser or network.
export interface Wire {
  peer: string; open: boolean; serialization: string;
  dataChannel?: { bufferedAmount: number };
  on(event: "open" | "close", listener: () => void): unknown;
  on(event: "data", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  send(data: string): void | Promise<void>; close(): void;
}
export interface PeerPort {
  on(event: "open", listener: (id: string) => void): unknown;
  on(event: "connection", listener: (wire: Wire) => void): unknown;
  on(event: "disconnected" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: { type?: string }) => void): unknown;
  on(event: "call", listener: (call: { close(): void }) => void): unknown;
  connect(id: string, options: { serialization: string; reliable: boolean; label: string }): Wire;
  destroy(): void;
}
export const PEER_OPTIONS = {
  host: "0.peerjs.com", port: 443, path: "/", secure: true, debug: 0,
  referrerPolicy: "no-referrer" as const,
  // Explicitly replace PeerJS defaults: no TURN relay or embedded TURN credentials.
  config: { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] },
};
export type ChatStatus = "preparing" | "waiting" | "connecting" | "authenticating" | "connected";
export interface ChatOptions {
  role: Role; invite: Invite; nickname: string;
  createPeer(id: string, options: typeof PEER_OPTIONS): PeerPort;
  onStatus(status: ChatStatus, remoteNickname?: string): void;
  onMessage(message: ChatMessage): void; onDelivered(id: string): void; onUnconfirmed(id: string): void;
  onRead?(ids: string[]): void;
  onEnd(reason: string): void;
  now?: () => number; monotonic?: () => number;
  // Code rooms claim two stable PeerServer slots; legacy invites stay unchanged.
  fixedGuestId?: string;
  onRoom?(role: Role, invite: Invite): void;
}
export class PeerChat {
  private options: ChatOptions;
  private peer?: PeerPort;
  private wire?: Wire;
  private session?: SecureSession;
  private closed = false;
  private authenticated = false;
  private started = false;
  private opened = false;
  private signalingLost = false;
  private localId: string;
  private now: () => number;
  private mono: () => number;
  private deadline: number;
  private connectDeadline: number;
  private wireDeadline = 0;
  private timer?: ReturnType<typeof setInterval>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private elections = 0;
  constructor(options: ChatOptions) {
    if (options.fixedGuestId && (options.role !== "host" || !PEER_ID.test(options.fixedGuestId) || options.fixedGuestId === options.invite.hostId)) throw new Error("INVALID_ROOM");
    this.options = { ...options, invite: { ...options.invite }, nickname: validateNickname(options.nickname) };
    this.localId = options.role === "host" ? options.invite.hostId : randomPeerId();
    this.now = options.now ?? Date.now; this.mono = options.monotonic ?? (() => performance.now());
    this.deadline = this.mono() + Math.min(ROOM_TTL_MS, Math.max(0, options.invite.expiresAt - this.now()));
    this.connectDeadline = this.mono() + 30000;
  }
  get remaining() { return Math.max(0, Math.min(this.options.invite.expiresAt - this.now(), this.deadline - this.mono())); }
  start() {
    if (this.closed || this.started) return;
    this.started = true;
    if (!this.remaining) { this.close("ROOM_EXPIRED"); return; }
    this.registerPeer();
    if (!this.closed) this.timer = setInterval(() => this.tick(), 1000);
  }
  private registerPeer() {
    if (this.closed) return;
    try {
      const peer = this.options.createPeer(this.localId, PEER_OPTIONS); this.peer = peer;
      const current = () => !this.closed && this.peer === peer;
      peer.on("open", id => {
        if (!current()) return;
        if (id !== this.localId) { this.close("CONNECTION_FAILED"); return; }
        this.opened = true;
        this.options.onRoom?.(this.options.role, { ...this.options.invite });
        if (this.options.role === "host") this.options.onStatus("waiting");
        else {
          this.options.onStatus("connecting");
          try { this.attach(peer.connect(this.options.invite.hostId, { serialization: "raw", reliable: true, label: this.options.fixedGuestId ? "one-chat-code-v1" : "one-chat-v2" })); }
          catch { this.close("RTC_UNAVAILABLE"); }
        }
      });
      peer.on("connection", wire => {
        if (!current() || this.options.role !== "host" || this.wire) { wire.close(); return; }
        this.attach(wire);
      });
      peer.on("call", call => call.close());
      peer.on("disconnected", () => {
        if (!current()) return;
        this.signalingLost = true;
        // Fixed rooms must release their RTC channel if a reserved slot is lost.
        // Legacy invite rooms can keep an established channel without signaling.
        if (this.options.fixedGuestId || !this.authenticated) this.close("SIGNAL_UNAVAILABLE");
      });
      peer.on("close", () => { if (current()) this.close("DISCONNECTED"); });
      peer.on("error", error => {
        if (!current()) return;
        if (error.type === "unavailable-id" && this.options.fixedGuestId && !this.opened) {
          if (this.options.role === "guest") { this.close("ROOM_FULL"); return; }
          // Ignore the failed candidate's subsequent disconnected/close events.
          this.peer = undefined; peer.destroy();
          this.options.role = "guest"; this.localId = this.options.fixedGuestId;
          this.registerPeer(); return;
        }
        if (this.authenticated && error.type === "peer-unavailable") return;
        if (error.type === "network" || error.type === "socket-error" || error.type === "server-error" || error.type === "socket-closed") {
          if (!this.authenticated || this.options.fixedGuestId) this.close("SIGNAL_UNAVAILABLE");
          return;
        }
        // Late SDP errors for rejected connections must not close the active wire.
        if (error.type === "webrtc") return;
        if (error.type === "peer-unavailable") {
          if (this.options.fixedGuestId && !this.authenticated && this.elections < 2) this.retryElection();
          else this.close("ROOM_UNAVAILABLE");
        } else this.close("CONNECTION_FAILED");
      });
    } catch { this.close("SIGNAL_UNAVAILABLE"); }
  }
  private retryElection() {
    this.elections++;
    const peer = this.peer, wire = this.wire;
    this.peer = undefined; this.wire = undefined;
    this.session?.close("ROOM_UNAVAILABLE"); this.session = undefined;
    try { wire?.close(); } catch { /* Old connection cleanup is best effort. */ }
    try { peer?.destroy(); } catch { /* Do not let old callbacks close the new peer. */ }
    this.opened = false; this.signalingLost = false;
    this.options.role = "host"; this.localId = this.options.invite.hostId;
    this.options.onStatus("preparing");
    this.retryTimer = setTimeout(() => this.registerPeer(), 250);
  }
  private attach(wire: Wire) {
    const expectedPeer = this.options.role === "host" ? this.options.fixedGuestId : this.options.invite.hostId;
    if (!PEER_ID.test(wire.peer) || wire.peer === this.localId || wire.serialization !== "raw" || (expectedPeer && wire.peer !== expectedPeer)) { wire.close(); return; }
    this.wire = wire; this.wireDeadline = this.mono() + 30000;
    this.options.onStatus("connecting");
    let started = false, session: SecureSession | undefined;
    const early: string[] = [];
    const current = () => !this.closed && this.wire === wire;
    const createSession = () => {
      session = new SecureSession({
        invite: this.options.invite, role: this.options.role, localId: this.localId, remoteId: wire.peer, nickname: this.options.nickname,
        now: this.now, monotonic: this.mono, deadline: this.deadline,
        send: data => {
          if (!current() || !wire.open || (wire.dataChannel?.bufferedAmount ?? 0) > 256 * 1024) throw new Error("DISCONNECTED");
          const sent = wire.send(data);
          if (sent) void sent.catch(() => session?.close("DISCONNECTED"));
        },
        closeWire: () => { try { wire.close(); } catch { /* Cleanup must still finish. */ } },
        onReady: nickname => { if (current()) { this.authenticated = true; this.options.onStatus("connected", nickname); } },
        onMessage: message => { if (current()) this.options.onMessage(message); },
        onDelivered: id => { if (current()) this.options.onDelivered(id); },
        onRead: this.options.onRead ? ids => { if (current()) this.options.onRead?.(ids); } : undefined,
        onUnconfirmed: id => { if (current()) this.options.onUnconfirmed(id); },
        onClose: reason => { if (current()) this.finishWire(reason); },
      });
      this.session = session;
      return session;
    };
    // The host's expiry is authenticated by the existing HMAC transcript. No key,
    // code, nickname or message is included in this bootstrap frame.
    const receive = (raw: string) => {
      if (!current()) return;
      if (this.options.fixedGuestId && this.options.role === "guest" && !session) {
        try {
          const setup = JSON.parse(raw) as { version?: unknown; type?: unknown; expiresAt?: unknown };
          if (!setup || setup.version !== 3 || setup.type !== "room" || typeof setup.expiresAt !== "number" || !Number.isSafeInteger(setup.expiresAt) || setup.expiresAt <= this.now() || setup.expiresAt > this.now() + ROOM_TTL_MS + 5 * 60 * 1000) throw new Error("INVALID_FRAME");
          this.options.invite.expiresAt = setup.expiresAt;
          this.deadline = Math.min(this.deadline, this.mono() + Math.max(0, setup.expiresAt - this.now()));
          this.options.onRoom?.(this.options.role, { ...this.options.invite });
          createSession().start();
        } catch { this.finishWire("AUTH_FAILED"); }
        return;
      }
      if (!session?.ended) void session?.receive(raw);
    };
    const open = () => {
      if (started || !current()) return;
      started = true; this.wireDeadline = this.mono() + 15000;
      this.options.onStatus("authenticating");
      try {
        if (!this.options.fixedGuestId || this.options.role === "host") {
          const next = createSession();
          if (this.options.fixedGuestId) {
            const sent = wire.send(JSON.stringify({ version: 3, type: "room", expiresAt: this.options.invite.expiresAt }));
            if (sent) void sent.catch(() => next.close("DISCONNECTED"));
          }
          next.start();
        }
        for (const frame of early) receive(frame);
        early.length = 0;
      } catch { this.finishWire("CONNECTION_FAILED"); }
    };
    wire.on("data", raw => {
      if (!current() || session?.ended) return;
      if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) { this.finishWire("INVALID_FRAME"); return; }
      if (started) receive(raw);
      else if (early.length < 8) early.push(raw);
      else this.finishWire("INVALID_FRAME");
    });
    wire.on("open", open);
    wire.on("close", () => { early.length = 0; if (current()) { if (session) session.close("DISCONNECTED"); else this.finishWire("DISCONNECTED"); } });
    wire.on("error", () => { if (current()) this.finishWire("CONNECTION_FAILED"); });
    if (wire.open) open();
  }
  private finishWire(reason: string) {
    const session = this.session, wire = this.wire;
    this.session = undefined; this.wire = undefined;
    session?.close(reason);
    try { wire?.close(); } catch { /* Session cleanup must still finish. */ }
    if (this.closed) return;
    if (this.options.role === "host" && !this.authenticated && this.remaining > 0 && !this.signalingLost) this.options.onStatus("waiting");
    else this.close(reason);
  }
  tick() {
    if (this.closed) return;
    if (!this.remaining) { this.close("ROOM_EXPIRED"); return; }
    if (!this.opened && this.mono() >= this.connectDeadline) { this.close("SIGNAL_TIMEOUT"); return; }
    if (this.options.role === "guest" && !this.authenticated && this.mono() >= this.connectDeadline) { this.close(this.wire?.open ? "AUTH_TIMEOUT" : "RTC_TIMEOUT"); return; }
    if (this.wire && !this.authenticated && this.mono() >= this.wireDeadline) this.finishWire(this.wire.open ? "AUTH_TIMEOUT" : "RTC_TIMEOUT");
    if (this.wire?.open) this.session?.tick();
  }
  send(text: string): Promise<void> {
    if (!this.remaining) { this.close("ROOM_EXPIRED"); return Promise.reject(new Error("ROOM_EXPIRED")); }
    if (this.closed || !this.session?.ready) return Promise.reject(new Error("DISCONNECTED"));
    return this.session.sendMessage(text);
  }
  markRead(ids: readonly string[]): Promise<void> {
    if (this.closed || !this.session?.ready) return Promise.resolve();
    return this.session.markRead(ids);
  }
  close(reason = "LEFT_ROOM") {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); clearTimeout(this.retryTimer);
    this.session?.close(reason);
    try { this.peer?.destroy(); } catch { /* Clear local data even if the transport has already failed. */ }
    this.session = undefined; this.wire = undefined; this.peer = undefined;
    this.options.invite.key = ""; this.options.nickname = "";
    this.options.onEnd(reason);
  }
}
