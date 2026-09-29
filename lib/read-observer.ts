import { MAX_READ_IDS } from "./protocol.ts";

export interface ReadObserver { refresh(): void; dispose(): void }

// No polling: inspect at most the retained rows after layout, scrolling or focus
// changes. Browser visibility is a display heuristic, not proof of human attention.
export function observeReadMessages(box: HTMLElement, enabled: () => boolean, onRead: (ids: string[]) => Promise<void>): ReadObserver {
  const doc = box.ownerDocument, win = doc.defaultView!;
  const reported = new Set<string>();
  let frame: number | null = null, disposed = false;
  const inspect = () => {
    frame = null;
    if (disposed) return;
    const rows = Array.from(box.querySelectorAll<HTMLElement>("[data-read-id]"));
    const retained = new Set(rows.map(row => row.dataset.readId!));
    for (const id of reported) if (!retained.has(id)) reported.delete(id);
    if (!enabled() || !box.isConnected || doc.visibilityState !== "visible" || !doc.hasFocus() || box.closest('[inert], [aria-hidden="true"]')) return;
    const bounds = box.getBoundingClientRect();
    const viewport = { top: Math.max(0, bounds.top), left: Math.max(0, bounds.left), bottom: Math.min(win.innerHeight, bounds.bottom), right: Math.min(win.innerWidth, bounds.right) };
    const height = viewport.bottom - viewport.top, width = viewport.right - viewport.left;
    if (height <= 0 || width <= 0) return;
    const ids: string[] = [];
    for (const row of rows) {
      const id = row.dataset.readId!;
      if (reported.has(id)) continue;
      const rect = row.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) continue;
      const top = Math.max(rect.top, viewport.top), bottom = Math.min(rect.bottom, viewport.bottom);
      const left = Math.max(rect.left, viewport.left), right = Math.min(rect.right, viewport.right);
      // At least half the bubble, or half a viewport for a very long message.
      if (bottom - top < Math.min(rect.height, height) / 2 || right - left < Math.min(rect.width, width) / 2) continue;
      const hit = doc.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!hit || !row.contains(hit)) continue; // Covered by a dialog or popover.
      ids.push(id);
      if (ids.length === MAX_READ_IDS) break;
    }
    if (!ids.length) return;
    for (const id of ids) reported.add(id);
    void onRead(ids).catch(() => { for (const id of ids) reported.delete(id); });
  };
  const refresh = () => { if (!disposed && frame === null) frame = win.requestAnimationFrame(inspect); };
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
  resize?.observe(box);
  win.addEventListener("focus", refresh);
  win.addEventListener("blur", refresh);
  win.addEventListener("resize", refresh);
  win.addEventListener("scroll", refresh, true);
  doc.addEventListener("visibilitychange", refresh);
  doc.addEventListener("focusin", refresh);
  box.addEventListener("load", refresh, true);
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      if (frame !== null) win.cancelAnimationFrame(frame);
      frame = null; reported.clear(); resize?.disconnect();
      win.removeEventListener("focus", refresh);
      win.removeEventListener("blur", refresh);
      win.removeEventListener("resize", refresh);
      win.removeEventListener("scroll", refresh, true);
      doc.removeEventListener("visibilitychange", refresh);
      doc.removeEventListener("focusin", refresh);
      box.removeEventListener("load", refresh, true);
    },
  };
}
