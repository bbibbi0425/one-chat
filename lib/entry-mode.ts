import { deriveCodeRoom, normalizeRoomCode } from "./code-room.ts";
import type { CodeRoom } from "./code-room.ts";
import { encode64, ROOM_TTL_MS } from "./protocol.ts";
import type { Invite, Role } from "./protocol.ts";

export type EntryMode = "open" | "code";
export type RoomMode = EntryMode | "invite";
export interface RoomEntry {
  invite: Invite;
  role: Role;
  code: string;
  mode: RoomMode;
  fixedGuestId?: string;
}
export async function deriveOpenRoom(currentUrl: string): Promise<CodeRoom> {
  const url = new URL(currentUrl);
  const path = url.pathname.replace(/\/index\.html$/, "/").replace(/\/?$/, "/");
  const scope = url.origin + path;
  const utf8 = new TextEncoder();
  const derive = async (label: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode("one-chat/open-room/v1:" + scope + ":" + label)));
  const [host, guest, key] = await Promise.all([derive("host-slot"), derive("guest-slot"), derive("public-protocol-key")]);
  const id = (bytes: Uint8Array) => "oc-" + Array.from(bytes.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("");
  // This key is public protocol material, NOT an access secret. Anyone who knows
  // the site's address can derive it and occupy an available slot.
  return { hostId: id(host), guestId: id(guest), key: encode64(key) };
}
export async function prepareRoomEntry(mode: EntryMode, roomCode: string, currentUrl: string, invite: Invite | null = null, now = Date.now()): Promise<RoomEntry> {
  // Preserve old invitation URLs without exposing a third entry mode in the UI.
  if (invite) {
    if (invite.expiresAt <= now) throw new Error("ROOM_EXPIRED");
    return { invite: { ...invite }, role: "guest", code: "", mode: "invite" };
  }
  const code = mode === "code" ? normalizeRoomCode(roomCode).match(/.{4}/g)!.join("-") : "";
  const fixed = mode === "code" ? await deriveCodeRoom(code) : await deriveOpenRoom(currentUrl);
  return { invite: { version: 2, hostId: fixed.hostId, key: fixed.key, expiresAt: now + ROOM_TTL_MS }, role: "host", code, mode, fixedGuestId: fixed.guestId };
}
