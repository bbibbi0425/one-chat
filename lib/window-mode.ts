import { inviteHash } from "./protocol.ts";
import type { Invite } from "./protocol.ts";

export function readWindowMode(search: string) {
  const params = new URLSearchParams(search);
  return { compact: params.get("window") === "compact", noteMode: params.get("theme") === "notes" };
}

export function popupUrl(currentUrl: string, invite: Invite | null, noteMode: boolean): string {
  const url = new URL(currentUrl);
  // Only display preferences belong in the query. Rebuild the invite from memory.
  url.search = "";
  url.hash = invite ? inviteHash(invite) : "";
  url.searchParams.set("window", "compact");
  if (noteMode) url.searchParams.set("theme", "notes");
  return url.href;
}
