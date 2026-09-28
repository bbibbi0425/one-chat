import { decode64, encode64, validSecret, validatePayload } from "./protocol.ts";
import type { Invite, Role, Payload } from "./protocol.ts";
export interface Transcript { hostId: string; guestId: string; expiresAt: number; hostChallenge: string; guestChallenge: string }
export interface TrafficKeys { send: CryptoKey; receive: CryptoKey; sessionId: string; role: Role }
const utf8 = new TextEncoder();
export function transcriptBytes(t: Transcript): Uint8Array<ArrayBuffer> {
  return utf8.encode(JSON.stringify(["one-chat", 2, t.hostId, t.guestId, t.expiresAt, t.hostChallenge, t.guestChallenge]));
}
function keyBytes(invite: Invite) {
  if (!validSecret(invite.key)) throw new Error("INVALID_KEY");
  return decode64(invite.key);
}
export async function makeProof(invite: Invite, t: Transcript, role: Role): Promise<string> {
  const key = await crypto.subtle.importKey("raw", keyBytes(invite), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encode64(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8.encode(`${role}-proof:${new TextDecoder().decode(transcriptBytes(t))}`))));
}
export async function verifyProof(invite: Invite, t: Transcript, role: Role, proof: string): Promise<boolean> {
  if (!validSecret(proof)) return false;
  const key = await crypto.subtle.importKey("raw", keyBytes(invite), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, decode64(proof), utf8.encode(`${role}-proof:${new TextDecoder().decode(transcriptBytes(t))}`));
}
export async function deriveTrafficKeys(invite: Invite, t: Transcript, role: Role): Promise<TrafficKeys> {
  const salt = new Uint8Array(await crypto.subtle.digest("SHA-256", transcriptBytes(t)));
  const master = await crypto.subtle.importKey("raw", keyBytes(invite), "HKDF", false, ["deriveKey"]);
  async function derive(direction: Role) {
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: utf8.encode(`one-chat/v2/${direction}`) }, master, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  const [host, guest] = await Promise.all([derive("host"), derive("guest")]);
  return { send: role === "host" ? host : guest, receive: role === "host" ? guest : host, role, sessionId: encode64(salt) };
}
function parameters(keys: TrafficKeys, direction: Role, sequence: number) {
  if (!Number.isInteger(sequence) || sequence <= 0 || sequence > 0xffffffff) throw new Error("INVALID_SEQUENCE");
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, sequence);
  return { name: "AES-GCM", iv, additionalData: utf8.encode(JSON.stringify([2, keys.sessionId, direction, sequence])) };
}
export async function seal(keys: TrafficKeys, sequence: number, payload: Payload): Promise<string> {
  const bytes = utf8.encode(JSON.stringify(validatePayload(payload)));
  return encode64(new Uint8Array(await crypto.subtle.encrypt(parameters(keys, keys.role, sequence), keys.send, bytes)));
}
export async function unseal(keys: TrafficKeys, sequence: number, ciphertext: string): Promise<Payload> {
  const direction = keys.role === "host" ? "guest" : "host";
  const plaintext = await crypto.subtle.decrypt(parameters(keys, direction, sequence), keys.receive, decode64(ciphertext));
  return validatePayload(JSON.parse(new TextDecoder().decode(plaintext)));
}
