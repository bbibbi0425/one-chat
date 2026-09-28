// Include the complete pack in the initial app bundle, so sticker choices do not
// cause emotion-specific HTTP image requests. Only fixed catalog entries are used.
import dance from "@/assets/stickers/bo-dance-v1.png?inline";
import love from "@/assets/stickers/bo-love-v1.png?inline";
import happy from "@/assets/stickers/bo-happy-v1.png?inline";
import wow from "@/assets/stickers/bo-wow-v1.png?inline";
import smile from "@/assets/stickers/bo-smile-v1.png?inline";
import blank from "@/assets/stickers/bo-blank-v1.png?inline";

export const STICKER_SOURCES: Readonly<Record<string, string>> = {
  "bo-dance-v1": dance, "bo-love-v1": love, "bo-happy-v1": happy,
  "bo-wow-v1": wow, "bo-smile-v1": smile, "bo-blank-v1": blank,
};
