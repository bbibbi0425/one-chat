import { inviteHash } from "./protocol.ts";
import type { Invite } from "./protocol.ts";

export const DEFAULT_FONT_SIZE = 14;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 20;

function safeFontSize(size: number): number {
  return Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE ? size : DEFAULT_FONT_SIZE;
}

export function readWindowMode(search: string) {
  const params = new URLSearchParams(search);
  return { compact: params.get("window") === "compact", noteMode: params.get("theme") === "notes", fontSize: safeFontSize(Number(params.get("font"))) };
}

export function popupUrl(currentUrl: string, invite: Invite | null, noteMode: boolean, fontSize = DEFAULT_FONT_SIZE): string {
  const url = new URL(currentUrl);
  // Only display preferences belong in the query. Rebuild the invite from memory.
  url.search = "";
  url.hash = invite ? inviteHash(invite) : "";
  url.searchParams.set("window", "compact");
  if (noteMode) url.searchParams.set("theme", "notes");
  const size = safeFontSize(fontSize);
  if (size !== DEFAULT_FONT_SIZE) url.searchParams.set("font", String(size));
  return url.href;
}
