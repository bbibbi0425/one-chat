import { memo, useEffect, useRef, useState } from "react";
import { LoaderCircle, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MAX_MESSAGE_CHARS } from "@/lib/protocol";
interface ComposerProps { connected: boolean; onSend(text: string): Promise<void> }
// Draft edits and sending indicators do not invalidate the transcript or the room header.
export const Composer = memo(function Composer({ connected, onSend }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const sendLock = useRef(false);
  const lifecycle = useRef(0);
  const invalidate = useRef(() => { lifecycle.current++; });
  useEffect(() => { const cancel = invalidate.current; return cancel; }, []);
  async function send() {
    if (!connected || sendLock.current || !draft.trim()) return;
    const generation = lifecycle.current;
    sendLock.current = true; setSending(true); setError("");
    try {
      await onSend(draft);
      if (generation === lifecycle.current) setDraft("");
    } catch (error) {
      if (generation === lifecycle.current) setError(error instanceof Error && error.message === "MESSAGE_LIMIT" ? "이 방의 전송 한도에 도달했어요. 전달을 기다리거나 새 방을 만들어 주세요." : "메시지를 보내지 못했어요. 연결 상태를 확인해 주세요.");
    } finally {
      if (generation === lifecycle.current) { sendLock.current = false; setSending(false); }
    }
  }
  return <form className="composer" onSubmit={event => { event.preventDefault(); void send(); }}>
    {error && <div className="error" role="alert" tabIndex={0}>{error}</div>}
    <div className="compose-row"><Textarea aria-label="메시지" autoComplete="off" spellCheck={false} placeholder={connected ? "메시지 입력" : "연결 대기 중"} maxLength={MAX_MESSAGE_CHARS} value={draft} readOnly={sending} disabled={!connected} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} /><Button type="submit" className="send-button" aria-label="메시지 보내기" disabled={sending || !connected || !draft.trim()}>{sending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}</Button></div>
    <div className="composer-hint"><span>Enter 전송 · Shift+Enter 줄바꿈</span><span>{draft.length.toLocaleString()}/2,000</span></div>
  </form>;
});
