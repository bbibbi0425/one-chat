import { memo, useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Send, Smile, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StickerImage } from "@/components/chat/sticker-image";
import { MAX_MESSAGE_CHARS } from "@/lib/protocol";
import { STICKERS, stickerMessage } from "@/lib/stickers";
import type { Sticker } from "@/lib/stickers";
interface ComposerProps { connected: boolean; onSend(text: string): Promise<void> }
// Draft edits and sending indicators do not invalidate the transcript or the room header.
export const Composer = memo(function Composer({ connected, onSend }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedSticker, setSelectedSticker] = useState<Sticker | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const focusDraft = useRef(false);
  const pickerTitle = useId(), pickerHint = useId();
  const sendLock = useRef(false);
  const lifecycle = useRef(0);
  const invalidate = useRef(() => { lifecycle.current++; });
  useEffect(() => { const cancel = invalidate.current; return cancel; }, []);
  async function send(sticker?: Sticker) {
    if (!connected || sendLock.current || (!sticker && !draft.trim())) return;
    const generation = lifecycle.current;
    sendLock.current = true; setSending(true); setError("");
    try {
      await onSend(sticker ? stickerMessage(sticker) : draft);
      if (generation === lifecycle.current) {
        if (sticker) { setSelectedSticker(null); focusDraft.current = true; setPickerOpen(false); }
        else setDraft("");
      }
    } catch (error) {
      if (generation === lifecycle.current) setError(error instanceof Error && error.message === "MESSAGE_LIMIT" ? "이 방의 전송 한도에 도달했어요. 전달을 기다리거나 새 방을 만들어 주세요." : "메시지를 보내지 못했어요. 연결 상태를 확인해 주세요.");
    } finally {
      if (generation === lifecycle.current) { sendLock.current = false; setSending(false); }
    }
  }
  return <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
    {error && !pickerOpen && <div className="error" role="alert" tabIndex={0}>{error}</div>}
    <div className="compose-row">
      <Popover open={pickerOpen && connected} onOpenChange={open => { focusDraft.current = false; setPickerOpen(open); }}>
        <PopoverTrigger asChild><Button type="button" variant="outline" className="sticker-trigger" aria-label="스티커 고르기" title="스티커" disabled={!connected}><Smile size={20} aria-hidden="true" /></Button></PopoverTrigger>
        <PopoverContent className="sticker-picker" side="top" align="start" sideOffset={8} collisionPadding={8} aria-labelledby={pickerTitle} aria-describedby={pickerHint} onCloseAutoFocus={event => { if (focusDraft.current) { event.preventDefault(); focusDraft.current = false; textarea.current?.focus(); } }}>
          <div className="sticker-picker-header"><h2 id={pickerTitle}>스티커</h2><Button type="button" variant="ghost" className="sticker-close" aria-label="스티커 닫기" onClick={() => setPickerOpen(false)}><X size={16} aria-hidden="true" /></Button></div>
          <p id={pickerHint} className="sticker-hint">고른 뒤 보내기를 누르세요.</p>
          <div className="sticker-options">
            {STICKERS.map(sticker => <Button key={sticker.id} type="button" variant="ghost" className="sticker-option" aria-label={`${sticker.label} 스티커 선택`} aria-pressed={selectedSticker?.id === sticker.id} disabled={sending || !connected} onClick={() => setSelectedSticker(sticker)}><StickerImage sticker={sticker} decorative /><span>{sticker.label}</span></Button>)}
          </div>
          {error && <div className="error sticker-error" role="alert" tabIndex={0}>{error}</div>}
          <div className="sticker-picker-footer"><span aria-live="polite">{selectedSticker ? `${selectedSticker.label} 선택됨` : "스티커를 골라 주세요"}</span><Button type="button" disabled={!selectedSticker || sending || !connected} aria-label="선택한 스티커 보내기" onClick={() => { if (selectedSticker) void send(selectedSticker); }}>{sending ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}보내기</Button></div>
        </PopoverContent>
      </Popover>
      <Textarea ref={textarea} aria-label="메시지" autoComplete="off" spellCheck={false} placeholder={connected ? "메시지 입력" : "연결 대기 중"} maxLength={MAX_MESSAGE_CHARS} value={draft} readOnly={sending} disabled={!connected} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} />
      <Button type="submit" className="send-button" aria-label="메시지 보내기" disabled={sending || !connected || !draft.trim()}>{sending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}</Button>
    </div>
    <div className="composer-hint"><span>Enter 전송 · Shift+Enter 줄바꿈</span><span>{draft.length.toLocaleString()}/2,000</span></div>
  </form>;
});
