export const ROOM_TTL_MS = 9 * 60 * 60 * 1000;
export const PAGE_SIZE = 100;
export const MAX_MESSAGE_CHARS = 2000;
export const MAX_NICKNAME_CHARS = 20;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export interface Room { id: string; createdAt: number; expiresAt: number }
export interface Envelope { id: string; iv: string; ciphertext: string }
export interface StoredMessage extends Envelope { sequence: number; senderId: string; createdAt: number }
export interface PlainMessage { nickname: string; text: string }
export interface Invite { roomId: string; token: string; key: string }
export interface Session { room: Room; senderId: string; sessionToken: string; serverNow: number }

export function encode64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decode64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("INVALID_ENCODING");
  const value = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - text.length % 4) % 4));
  const result = Uint8Array.from(value, (c) => c.charCodeAt(0));
  if (encode64(result) !== text) throw new Error("INVALID_ENCODING");
  return result;
}
export function randomToken(): string { return encode64(crypto.getRandomValues(new Uint8Array(32))); }
export async function hashToken(token: string): Promise<string> {
  return encode64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}
