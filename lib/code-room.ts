import { encode64 } from "./protocol.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROOM_CODE_LENGTH = 20;
export interface CodeRoom { hostId: string; guestId: string; key: string }
export function normalizeRoomCode(value: string): string {
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(code)) throw new Error("INVALID_ROOM_CODE");
  return code;
}
export function createRoomCode(): string {
  // Twenty independent base-32 symbols provide 100 bits of random input.
  const code = Array.from(crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH)), byte => ALPHABET[byte & 31]).join("");
  return code.match(/.{4}/g)!.join("-");
}
export async function deriveCodeRoom(value: string): Promise<CodeRoom> {
  const utf8 = new TextEncoder();
  const source = await crypto.subtle.importKey("raw", utf8.encode(normalizeRoomCode(value)), "HKDF", false, ["deriveBits"]);
  async function derive(label: string) {
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: utf8.encode("one-chat/code-room/v1"), info: utf8.encode(label) }, source, 256));
  }
  const [host, guest, key] = await Promise.all([derive("host-slot"), derive("guest-slot"), derive("authentication-key")]);
  const id = (bytes: Uint8Array) => `oc-${Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  return { hostId: id(host), guestId: id(guest), key: encode64(key) };
}
