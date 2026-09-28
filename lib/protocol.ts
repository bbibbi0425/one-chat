export const ROOM_TTL_MS = 9 * 60 * 60 * 1000;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_NICKNAME_CHARS = 20;
export const MAX_MESSAGES = 2000;
export const MAX_FRAME_CHARS = 20000;
export const PEER_ID = /^oc-[0-9a-f]{32}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type Role = "host" | "guest";
export interface Invite { version: 2; hostId: string; key: string; expiresAt: number }
export interface ChatMessage { id: string; nickname: string; text: string; time: number; mine: boolean; delivered: boolean }
export type Payload = { type: "ready"; nickname: string } | { type: "message"; id: string; text: string } | { type: "ack"; id: string } | { type: "ping" | "pong" };
export type Frame = { version: 2; type: "hello"; challenge: string } | { version: 2; type: "proof"; challenge?: string; proof: string } | { version: 2; type: "box"; sequence: number; ciphertext: string };
export function encode64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decode64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > MAX_FRAME_CHARS) throw new Error("INVALID_ENCODING");
  const value = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - text.length % 4) % 4));
  const result = Uint8Array.from(value, c => c.charCodeAt(0));
  if (encode64(result) !== text) throw new Error("INVALID_ENCODING");
  return result;
}
export function validSecret(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 43) return false;
  try { return decode64(value).length === 32; } catch { return false; }
}
export function randomToken(): string { return encode64(crypto.getRandomValues(new Uint8Array(32))); }
export function randomPeerId(): string { return `oc-${crypto.randomUUID().replaceAll("-", "")}`; }
export function createInvite(now = Date.now()): Invite { return { version: 2, hostId: randomPeerId(), key: randomToken(), expiresAt: now + ROOM_TTL_MS }; }
export function inviteHash(invite: Invite): string {
  return `#${new URLSearchParams({ v: "2", room: invite.hostId, key: invite.key, until: String(invite.expiresAt) })}`;
}
export function parseInvite(hash: string, now = Date.now()): Invite {
  if (hash.length > 512) throw new Error("INVALID_LINK");
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (["v", "room", "key", "until"].some(key => params.getAll(key).length !== 1)) throw new Error("INVALID_LINK");
  const hostId = params.get("room") ?? ""; const key = params.get("key") ?? "";
  const expiresAt = Number(params.get("until"));
  if (params.get("v") !== "2" || !PEER_ID.test(hostId) || !validSecret(key) || !Number.isSafeInteger(expiresAt)) throw new Error("INVALID_LINK");
  if (expiresAt <= now) throw new Error("ROOM_EXPIRED");
  if (expiresAt > now + ROOM_TTL_MS + 5 * 60 * 1000) throw new Error("INVALID_LINK");
  return { version: 2, hostId, key, expiresAt };
}
export function validateNickname(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_NICKNAME_CHARS) throw new Error("INVALID_NICKNAME");
  return value.trim();
}
export function validatePayload(value: unknown): Payload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_MESSAGE");
  const p = value as Record<string, unknown>;
  if (p.type === "ready") return { type: "ready", nickname: validateNickname(p.nickname) };
  if (p.type === "ping" || p.type === "pong") return { type: p.type };
  if ((p.type === "message" || p.type === "ack") && typeof p.id === "string" && UUID.test(p.id)) {
    if (p.type === "ack") return { type: "ack", id: p.id };
    if (typeof p.text === "string" && p.text.trim() && p.text.length <= MAX_MESSAGE_CHARS) return { type: "message", id: p.id, text: p.text };
  }
  throw new Error("INVALID_MESSAGE");
}
export function parseFrame(raw: unknown): Frame {
  if (typeof raw !== "string" || raw.length > MAX_FRAME_CHARS) throw new Error("INVALID_FRAME");
  const frame = JSON.parse(raw) as Record<string, unknown>;
  if (!frame || frame.version !== 2) throw new Error("INVALID_FRAME");
  if (frame.type === "hello" && validSecret(frame.challenge)) return frame as Frame;
  if (frame.type === "proof" && validSecret(frame.proof) && (frame.challenge === undefined || validSecret(frame.challenge))) return frame as Frame;
  if (frame.type === "box" && typeof frame.sequence === "number" && Number.isSafeInteger(frame.sequence) && frame.sequence > 0 && frame.sequence <= 0xffffffff && typeof frame.ciphertext === "string" && frame.ciphertext.length <= 18000) return frame as Frame;
  throw new Error("INVALID_FRAME");
}
