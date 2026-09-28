export interface Sticker { readonly id: string; readonly label: string; readonly file: string }
export const STICKERS: readonly Sticker[] = [
  { id: "bo-dance-v1", label: "신남", file: "bo-dance-v1.png" },
  { id: "bo-love-v1", label: "좋아해", file: "bo-love-v1.png" },
  { id: "bo-happy-v1", label: "행복", file: "bo-happy-v1.png" },
  { id: "bo-wow-v1", label: "감탄", file: "bo-wow-v1.png" },
  { id: "bo-smile-v1", label: "방긋", file: "bo-smile-v1.png" },
  { id: "bo-blank-v1", label: "멍", file: "bo-blank-v1.png" },
];
// Keep the existing encrypted text protocol compatible with older open tabs.
export function stickerMessage(sticker: Sticker): string { return `[스티커: ${sticker.label} · ${sticker.id}]`; }
const byMessage = new Map(STICKERS.map(sticker => [stickerMessage(sticker), sticker]));
// Never turn peer-controlled text into a URL. Unknown or partial tokens remain text.
export function getSticker(text: string): Sticker | undefined { return byMessage.get(text); }
