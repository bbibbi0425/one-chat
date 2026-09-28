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
  onEnd(reason: string): void;
  now?: () => number; monotonic?: () => number;
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
  constructor(options: ChatOptions) {
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
    try {
      const peer = this.options.createPeer(this.localId, PEER_OPTIONS); this.peer = peer;
      peer.on("open", id => {
        if (this.closed) return;
        if (id !== this.localId) { this.close("CONNECTION_FAILED"); return; }
        this.opened = true;
        if (this.options.role === "host") this.options.onStatus("waiting");
        else {
          this.options.onStatus("connecting");
          this.attach(peer.connect(this.options.invite.hostId, { serialization: "raw", reliable: true, label: "one-chat-v2" }));
        }
      });
      peer.on("connection", wire => {
        if (this.options.role !== "host" || this.wire || this.closed) { wire.close(); return; }
        this.attach(wire);
      });
      peer.on("call", call => call.close());
      peer.on("disconnected", () => {
        this.signalingLost = true;
        // Established RTC channels work independently of the signaling socket.
        if (!this.authenticated) this.close("SIGNAL_UNAVAILABLE");
      });
      peer.on("close", () => this.close("DISCONNECTED"));
      peer.on("error", error => {
        if (this.closed) return;
        if (this.authenticated && (error.type === "network" || error.type === "socket-error" || error.type === "server-error" || error.type === "socket-closed" || error.type === "peer-unavailable")) return;
        // PeerJS reports late SDP errors at peer level, even for rejected third connections.
        // Active-wire events and bounded deadlines own WebRTC failures.
        if (error.type === "webrtc") return;
        if (error.type === "peer-unavailable") this.close("ROOM_UNAVAILABLE");
        else this.close("CONNECTION_FAILED");
      });
      this.timer = setInterval(() => this.tick(), 1000);
    } catch { this.close("CONNECTION_FAILED"); }
  }
  private attach(wire: Wire) {
    if (!PEER_ID.test(wire.peer) || wire.peer === this.localId || wire.serialization !== "raw") { wire.close(); return; }
    this.wire = wire; this.wireDeadline = this.mono() + 30000;
    let started = false; const early: unknown[] = [];
    const session = new SecureSession({
      invite: this.options.invite, role: this.options.role, localId: this.localId, remoteId: wire.peer, nickname: this.options.nickname,
      now: this.now, monotonic: this.mono, deadline: this.deadline,
      send: data => {
        if (this.closed || !wire.open || (wire.dataChannel?.bufferedAmount ?? 0) > 256 * 1024) throw new Error("DISCONNECTED");
        const sent = wire.send(data);
        if (sent) void sent.catch(() => session.close("DISCONNECTED"));
      },
      closeWire: () => { try { wire.close(); } catch { /* Session cleanup must still finish. */ } },
      onReady: nickname => { if (!this.closed) { this.authenticated = true; this.options.onStatus("connected", nickname); } },
      onMessage: message => { if (!this.closed) this.options.onMessage(message); },
      onDelivered: id => { if (!this.closed) this.options.onDelivered(id); },
      onUnconfirmed: id => { if (!this.closed) this.options.onUnconfirmed(id); },
      onClose: reason => {
        if (this.closed) return;
        if (this.options.role === "host" && !this.authenticated && this.remaining > 0 && !this.signalingLost) {
          this.wire = undefined; this.session = undefined; this.options.onStatus("waiting");
        } else this.close(reason);
      },
    });
    this.session = session;
    const open = () => {
      if (started || this.closed || session.ended) return;
      started = true; this.options.onStatus("authenticating");
      try { session.start(); for (const frame of early) void session.receive(frame); early.length = 0; }
      catch { session.close("CONNECTION_FAILED"); }
    };
    wire.on("data", raw => {
      if (this.closed || session.ended) return;
      if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) { session.close("INVALID_FRAME"); return; }
      if (started) void session.receive(raw);
      else if (early.length < 8) early.push(raw);
      else session.close("INVALID_FRAME");
    });
    wire.on("open", open);
    wire.on("close", () => { early.length = 0; session.close("DISCONNECTED"); });
    wire.on("error", () => session.close("CONNECTION_FAILED"));
    if (wire.open) open();
  }
  tick() {
    if (this.closed) return;
    if (!this.remaining) { this.close("ROOM_EXPIRED"); return; }
    if ((!this.opened || (this.options.role === "guest" && !this.authenticated)) && this.mono() >= this.connectDeadline) { this.close("CONNECTION_TIMEOUT"); return; }
    if (this.wire && !this.wire.open && this.mono() >= this.wireDeadline) this.session?.close("CONNECTION_TIMEOUT");
    if (this.wire?.open) this.session?.tick();
  }
  send(text: string): Promise<void> {
    if (!this.remaining) { this.close("ROOM_EXPIRED"); return Promise.reject(new Error("ROOM_EXPIRED")); }
    if (this.closed || !this.session?.ready) return Promise.reject(new Error("DISCONNECTED"));
    return this.session.sendMessage(text);
  }
  close(reason = "LEFT_ROOM") {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer);
    this.session?.close(reason);
    try { this.peer?.destroy(); } catch { /* Clear local data even if the transport has already failed. */ }
    this.session = undefined; this.wire = undefined; this.peer = undefined;
    this.options.invite.key = ""; this.options.nickname = "";
    this.options.onEnd(reason);
  }
}
