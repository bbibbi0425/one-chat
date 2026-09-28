/* eslint-disable @next/next/no-img-element -- Static Vite app; small PNGs are bundled without an image server. */
import { memo, useState } from "react";
import { STICKER_SOURCES } from "@/components/chat/sticker-sources";
import type { Sticker } from "@/lib/stickers";

export const StickerImage = memo(function StickerImage({ sticker, decorative = false }: { sticker: Sticker; decorative?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <span className="sticker-art" aria-hidden={decorative || undefined}>
    {failed ? <span className="sticker-fallback">이미지 없음</span> : <img src={STICKER_SOURCES[sticker.id]} width={210} height={210} alt={decorative ? "" : `${sticker.label} 스티커`} decoding="async" draggable={false} onError={() => setFailed(true)} />}
  </span>;
});
