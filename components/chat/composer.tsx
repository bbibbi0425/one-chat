import { memo, useEffect, useRef, useState } from "react";
import { CornerDownLeft, LoaderCircle, Plus, Send, Smile, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StickerImage } from "@/components/chat/sticker-image";
import { MAX_MESSAGE_CHARS } from "@/lib/protocol";
import { STICKERS, stickerMessage } from "@/lib/stickers";
import type { Sticker } from "@/lib/stickers";
interface ComposerProps { noteMode: boolean; connected: boolean; onSend(text: string): Promise<void> }
// Draft edits and sending indicators do not invalidate the transcript or the room header.
export const Composer = memo(function Composer({ connected, onSend, noteMode }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedSticker, setSelectedSticker] = useState<Sticker | null>(null);
  const selection = useRef<Sticker | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const focusDraft = useRef(false);
  const sendLock = useRef(false);
  const lifecycle = useRef(0);
  const invalidate = useRef(() => { lifecycle.current++; });
  useEffect(() => { const cancel = invalidate.current; return cancel; }, []);
  function clearSelection() { selection.current = null; setSelectedSticker(null); }
  function changePicker(open: boolean) {
    focusDraft.current = false; clearSelection(); setPickerOpen(open);
  }
  function activateSticker(sticker: Sticker) {
    if (!connected || sendLock.current) return;
    if (selection.current?.id === sticker.id) {
      clearSelection(); void send(sticker);
    } else {
      selection.current = sticker; setSelectedSticker(sticker);
    }
  }
  async function send(sticker?: Sticker) {
    if (!connected || sendLock.current || (!sticker && !draft.trim())) return;
    const generation = lifecycle.current;
    sendLock.current = true; setSending(true); setError("");
    try {
      await onSend(sticker ? stickerMessage(sticker) : draft);
      if (generation === lifecycle.current) {
        if (sticker) { clearSelection(); focusDraft.current = true; setPickerOpen(false); }
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
      <Popover open={pickerOpen && connected} onOpenChange={changePicker}>
        <PopoverTrigger asChild><Button type="button" variant="outline" className="sticker-trigger" aria-label="스티커 고르기" title="스티커" disabled={!connected}>{noteMode ? <Plus size={20} aria-hidden="true" /> : <Smile size={20} aria-hidden="true" />}</Button></PopoverTrigger>
        <PopoverContent data-theme={noteMode ? "notes" : "default"} className="sticker-picker" side="top" align="start" sideOffset={8} collisionPadding={8} aria-label="스티커" onInteractOutside={event => { const target = event.detail.originalEvent.target; if (target instanceof Element && target.closest("[data-theme-switch]")) event.preventDefault(); }} onCloseAutoFocus={event => { if (focusDraft.current) { event.preventDefault(); focusDraft.current = false; textarea.current?.focus(); } }}>
          <div className="sticker-picker-header"><Button type="button" variant="ghost" className="sticker-close" aria-label="스티커 닫기" onClick={() => changePicker(false)}><X size={16} aria-hidden="true" /></Button></div>
          <div className="sticker-options" aria-busy={sending}>
            {STICKERS.map(sticker => <Button key={sticker.id} type="button" variant="ghost" className="sticker-option" aria-label={`${sticker.label} 스티커 ${selectedSticker?.id === sticker.id ? "보내기" : "선택"}`} aria-pressed={selectedSticker?.id === sticker.id} disabled={sending || !connected} onKeyDown={event => { if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault(); }} onClick={() => activateSticker(sticker)}><StickerImage sticker={sticker} decorative /></Button>)}
          </div>
          {error && <div className="error sticker-error" role="alert" tabIndex={0}>{error}</div>}
        </PopoverContent>
      </Popover>
      <Textarea ref={textarea} aria-label="메시지" autoComplete="off" spellCheck={false} placeholder={connected ? (noteMode ? "내용 입력" : "메시지 입력") : "연결 대기 중"} maxLength={MAX_MESSAGE_CHARS} value={draft} readOnly={sending} disabled={!connected} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} />
      <Button type="submit" className="send-button" aria-label="메시지 보내기" disabled={sending || !connected || !draft.trim()}>{sending ? <LoaderCircle className="spin" aria-hidden="true" /> : noteMode ? <CornerDownLeft size={18} aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}</Button>
    </div>
    <div className="composer-hint"><span>{noteMode ? "Enter 추가" : "Enter 전송"} · Shift+Enter 줄바꿈</span><span>{draft.length.toLocaleString()}/2,000</span></div>
  </form>;
});
