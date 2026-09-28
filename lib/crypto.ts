import { decode64, encode64, MAX_MESSAGE_CHARS, MAX_NICKNAME_CHARS, TOKEN, UUID } from "./protocol.ts";
import type { Envelope, Invite, PlainMessage } from "./protocol.ts";

export async function importRoomKey(value: string): Promise<CryptoKey> {
  if (!TOKEN.test(value) || decode64(value).length !== 32) throw new Error("INVALID_KEY");
  return crypto.subtle.importKey("raw", decode64(value), "AES-GCM", false, ["encrypt", "decrypt"]);
}
function additionalData(roomId: string, senderId: string, id: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(["one-chat", 1, roomId, senderId, id]));
}
function validatePlain(value: unknown): PlainMessage {
  if (!value || typeof value !== "object") throw new Error("INVALID_MESSAGE");
  const { nickname, text } = value as Record<string, unknown>;
  if (typeof nickname !== "string" || !nickname.trim() || nickname.length > MAX_NICKNAME_CHARS ||
      typeof text !== "string" || !text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error("INVALID_MESSAGE");
  return { nickname: nickname.trim(), text };
}
export async function encryptMessage(key: CryptoKey, roomId: string, senderId: string, message: PlainMessage): Promise<Envelope> {
  const id = crypto.randomUUID();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(validatePlain(message)));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(roomId, senderId, id) }, key, plaintext);
  return { id, iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) };
}
export async function decryptMessage(key: CryptoKey, roomId: string, senderId: string, message: Envelope): Promise<PlainMessage> {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(message.iv), additionalData: additionalData(roomId, senderId, message.id) }, key, decode64(message.ciphertext));
  return validatePlain(JSON.parse(new TextDecoder().decode(plaintext)));
}
export function parseInvite(hash: string): Invite {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const roomId = params.get("room") ?? "";
  const token = params.get("invite") ?? "";
  const key = params.get("key") ?? "";
  if (!UUID.test(roomId) || !TOKEN.test(token) || !TOKEN.test(key) || decode64(token).length !== 32 || decode64(key).length !== 32) throw new Error("INVALID_LINK");
  return { roomId, token, key };
}
export function inviteHash(invite: Invite): string {
  return `#${new URLSearchParams({ room: invite.roomId, invite: invite.token, key: invite.key })}`;
}
