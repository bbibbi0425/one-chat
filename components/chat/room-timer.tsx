import { memo, useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import type { PeerChat } from "@/lib/peer-chat";
function timeLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, "0")).join(":");
}
// The display clock updates only this small subtree. PeerChat owns connection/expiry checks.
export const RoomTimer = memo(function RoomTimer({ chat }: { chat: PeerChat }) {
  const [remaining, setRemaining] = useState(() => chat.remaining);
  useEffect(() => {
    const timer = setInterval(() => setRemaining(chat.remaining), 1000);
    return () => clearInterval(timer);
  }, [chat]);
  const label = timeLabel(remaining);
  return <span className="room-timer" role="timer" aria-label={`방 만료까지 ${label}`} title="방 만료까지 남은 시간"><Clock3 size={13} aria-hidden="true" />{label}</span>;
});
