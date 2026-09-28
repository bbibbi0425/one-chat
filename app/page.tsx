import { useCallback, useEffect, useRef, useState } from "react";
import Peer from "peerjs";
import { Check, Clock3, Copy, Info, LoaderCircle, LogOut, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PeerChat } from "@/lib/peer-chat";
import type { ChatStatus } from "@/lib/peer-chat";
import { createInvite, inviteHash, parseInvite, MAX_MESSAGE_CHARS, MAX_NICKNAME_CHARS } from "@/lib/protocol";
import type { ChatMessage, Invite, Role } from "@/lib/protocol";
import { useRoomStatusTool } from "@/hooks/use-room-status-tool";

type RoomView = { invite: Invite; role: Role; nickname: string };
const labels: Record<ChatStatus, string> = { preparing: "준비 중", waiting: "대기 중", connecting: "연결 중", authenticating: "확인 중", connected: "연결됨" };
function explanation(reason: string) {
  if (reason === "ROOM_EXPIRED") return "방의 9시간이 끝났어요. 새 방을 만들어 주세요.";
  if (reason === "LEFT_ROOM") return "방에서 나왔어요. 이전 대화는 다시 불러올 수 없어요.";
  if (reason === "AUTH_FAILED" || reason === "AUTH_TIMEOUT" || reason === "INVALID_FRAME") return "초대 링크를 확인하지 못했어요. 방을 만든 사람에게 새 링크를 받아 주세요.";
  if (reason === "ROOM_UNAVAILABLE") return "방이 닫혔거나 아직 준비되지 않았어요. 방을 만든 사람이 창을 열어 두었는지 확인해 주세요.";
  if (reason === "DISCONNECTED") return "상대방이 나갔거나 연결이 끊겨 방이 끝났어요. 이전 대화는 복원되지 않아요.";
  return "직접 연결하지 못했어요. 네트워크 환경에서 연결이 제한되거나 연결 서비스가 응답하지 않을 수 있어요.";
}
function readInvite(): { invite: Invite | null; error: string } {
  if (!window.location.hash) return { invite: null, error: "" };
  try { return { invite: parseInvite(window.location.hash), error: "" }; }
  catch (error) { return { invite: null, error: error instanceof Error && error.message === "ROOM_EXPIRED" ? explanation("ROOM_EXPIRED") : "초대 링크가 올바르지 않아요. 링크 전체를 다시 받아 주세요." }; }
}
function stripHash() { window.history.replaceState(null, "", window.location.pathname + window.location.search); }
function timeLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, "0")).join(":");
}
export default function Home() {
  const [entry, setEntry] = useState(readInvite);
  const [nickname, setNickname] = useState("");
  const [room, setRoom] = useState<RoomView | null>(null);
  const [status, setStatus] = useState<ChatStatus>("preparing");
  const [remoteName, setRemoteName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [unconfirmed, setUnconfirmed] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const active = useRef<PeerChat | null>(null);
  const generation = useRef(0);
  const sendLock = useRef(false);
  const scrollBox = useRef<HTMLDivElement>(null);
  const helpTitle = useRef<HTMLHeadingElement>(null);
  const stayAtBottom = useRef(true);
  useRoomStatusTool({ joined: !!room, connection: room ? labels[status] : "입장 전", expiresAt: room?.invite.expiresAt ?? null });

  const clearView = useCallback((message: string) => {
    setRoom(null); setMessages([]); setUnconfirmed(new Set()); setDraft(""); setNickname(""); setRemoteName("");
    setSending(false); sendLock.current = false; setError(""); setNotice(message);
    setCopyFallback(""); setCopied(false); setEntry({ invite: null, error: "" });
  }, []);
  const stopTransport = useCallback((reason = "LEFT_ROOM") => {
    generation.current++; const chat = active.current; active.current = null; chat?.close(reason);
  }, []);
  const end = useCallback((reason = "LEFT_ROOM") => {
    stopTransport(reason);
    clearView(explanation(reason)); stripHash();
  }, [clearView, stopTransport]);
  useEffect(() => {
    // Invite fragments are read once, then removed from the visible URL. No browser storage.
    stripHash();
    const hashchange = () => {
      const next = readInvite(); end(); setEntry(next); setNotice("");
    };
    const pagehide = () => end();
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) end(); };
    window.addEventListener("hashchange", hashchange); window.addEventListener("pagehide", pagehide); window.addEventListener("pageshow", pageshow);
    const timer = setInterval(() => { if (active.current) { active.current.tick(); setRemaining(active.current?.remaining ?? 0); } }, 1000);
    return () => {
      window.removeEventListener("hashchange", hashchange); window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", pageshow); clearInterval(timer);
      stopTransport();
    };
  }, [end, stopTransport]);
  useEffect(() => {
    if (stayAtBottom.current && scrollBox.current) scrollBox.current.scrollTop = scrollBox.current.scrollHeight;
  }, [messages]);

  function enterRoom() {
    if (active.current || !nickname.trim()) return;
    setError(""); setNotice("");
    if (!window.isSecureContext || !crypto.subtle || !window.RTCPeerConnection) { setError("HTTPS 또는 localhost에서 최신 브라우저로 접속해 주세요."); return; }
    const current = ++generation.current;
    try {
      const invite = entry.invite ?? createInvite();
      if (invite.expiresAt <= Date.now()) { setError(explanation("ROOM_EXPIRED")); return; }
      const target: RoomView = { invite, role: entry.invite ? "guest" : "host", nickname: nickname.trim() };
      setRoom(target); setEntry({ invite: null, error: "" }); setStatus("preparing"); setMessages([]); setUnconfirmed(new Set()); stayAtBottom.current = true;
      const chat = new PeerChat({ ...target, createPeer: (id, options) => new Peer(id, options),
        onStatus: (next, name) => { if (generation.current === current) { setStatus(next); if (name) setRemoteName(name); } },
        onMessage: message => { if (generation.current === current) setMessages(list => [...list, message]); },
        onDelivered: id => { if (generation.current === current) { setMessages(list => list.map(m => m.id === id ? { ...m, delivered: true } : m)); setUnconfirmed(ids => { const next = new Set(ids); next.delete(id); return next; }); } },
        onUnconfirmed: id => { if (generation.current === current) setUnconfirmed(ids => new Set([...ids, id])); },
        onEnd: reason => { if (generation.current === current) { generation.current++; active.current = null; clearView(explanation(reason)); } },
      });
      active.current = chat; setRemaining(chat.remaining); stripHash(); chat.start();
    } catch { end("CONNECTION_FAILED"); }
  }
  async function sendMessage() {
    if (!active.current || status !== "connected" || sendLock.current || !draft.trim()) return;
    const current = generation.current; sendLock.current = true; stayAtBottom.current = true; setSending(true); setError("");
    try {
      await active.current.send(draft);
      if (current === generation.current) { setDraft(""); }
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error && error.message === "MESSAGE_LIMIT" ? "이 방의 전송 한도에 도달했어요. 전달을 기다리거나 새 방을 만들어 주세요." : "메시지를 보내지 못했어요. 연결 상태를 확인해 주세요.");
    } finally { if (current === generation.current) { sendLock.current = false; setSending(false); } }
  }
  async function copyLink() {
    if (!room || room.role !== "host") return;
    const current = generation.current;
    const link = `${window.location.origin}${window.location.pathname}${inviteHash(room.invite)}`;
    try { await navigator.clipboard.writeText(link); if (generation.current === current) setCopied(true); }
    catch { if (generation.current === current) setCopyFallback(link); }
  }
  return <main className={`app-shell ${room ? "in-room" : "at-entry"}`}>
    <header className="site-header">
      <span className="brand">one-chat</span>
      <Dialog>
        <DialogTrigger asChild><Button variant="ghost" className="help-button"><Info aria-hidden="true" />안내</Button></DialogTrigger>
        <DialogContent className="help-dialog" showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); helpTitle.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle ref={helpTitle} tabIndex={-1}>사용 안내</DialogTitle>
            <DialogDescription>두 사람 전용 · 최대 9시간</DialogDescription>
          </DialogHeader>
          <div className="help-copy">
            <p>방을 만든 뒤 초대 링크를 한 사람에게 공유하세요. 둘 다 이 창을 열어 둔 동안 대화할 수 있어요.</p>
            <p>새로고침·나가기·연결 종료 시 대화가 끝나며 이전 내용은 다시 불러올 수 없어요. 연결 종료 감지에는 시간이 걸릴 수 있어요.</p>
            <p>메시지는 이 탭의 메모리에만 두고 앱의 DB·브라우저 저장소에 기록하지 않아요. ‘전달됨’은 상대 앱에 도착했다는 뜻이며 읽음 표시는 아니에요.</p>
            <p>초대 링크에는 비밀 키가 포함돼요. 링크를 가진 사람이 참여할 수 있으며 닉네임은 신원 인증이 아니에요. 9시간 만료는 각 브라우저에서 적용해요.</p>
            <p>연결에 PeerJS Cloud와 Google STUN을 사용하며 IP·접속 정보가 남을 수 있어요. 회사 기기의 기록이나 상대방의 복사본까지 지우거나 숨기는 기능은 아니에요.</p>
          </div>
          <DialogClose asChild><Button variant="outline" className="help-close">닫기</Button></DialogClose>
        </DialogContent>
      </Dialog>
    </header>
    {!room ? <section className="entry-layout" aria-labelledby="entry-title">
      <div className="entry-card">
        <h1 id="entry-title">{entry.invite ? "입장" : "새 방"}</h1>
        <form onSubmit={event => { event.preventDefault(); enterRoom(); }}>
          <label htmlFor="nickname">닉네임</label>
          <Input id="nickname" className="name-input" autoComplete="off" spellCheck={false} maxLength={MAX_NICKNAME_CHARS} value={nickname} onChange={event => setNickname(event.target.value)} placeholder="20자 이내" required />
          <Button className="primary-action" type="submit" disabled={!nickname.trim() || !!entry.error}>{entry.invite ? "입장하기" : "방 만들기"}</Button>
        </form>
        {(error || entry.error) && <p className="error" role="alert">{error || entry.error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {(entry.invite || entry.error) && <Button variant="ghost" className="new-room-link" onClick={() => { setEntry({ invite: null, error: "" }); setError(""); }}>새 방 만들기</Button>}
        <p className="entry-hint">{entry.invite ? "방을 만든 사람이 창을 열어 두어야 해요." : "방을 만든 뒤 초대 링크를 공유하세요."}</p>
      </div>
    </section> : <section className="chat-panel" aria-label="대화방">
      <header className="chat-header">
        <div className="chat-toolbar">
          <div className="room-identity">
            <h1 title={remoteName || "연결 대기"}>{remoteName || "연결 대기"}</h1>
            <span className="nickname-tag" title={room.nickname}>나: {room.nickname}</span>
          </div>
          <div className="room-actions">
            {room.role === "host" && status !== "connected" && <Button variant="outline" className="tool-button" disabled={status === "preparing"} aria-label={copied ? "초대 링크 다시 복사" : "초대 링크 복사"} title="초대 링크 복사" onClick={() => void copyLink()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "복사됨" : "링크"}</Button>}
            <Button variant="ghost" className="tool-button" onClick={() => end()} aria-label="방 나가기" title="방 나가기"><LogOut aria-hidden="true" />나가기</Button>
          </div>
        </div>
        <div className="room-meta">
          <span role="status" className={`connection-state ${status === "connected" ? "online" : ""}`}><i aria-hidden="true" />{labels[status]}</span>
          <span className="room-timer" role="timer" aria-label={`방 만료까지 ${timeLabel(remaining)}`} title="방 만료까지 남은 시간"><Clock3 size={13} aria-hidden="true" />{timeLabel(remaining)}</span>
        </div>
      </header>
      {copyFallback && status !== "connected" && <div className="manual-copy"><label htmlFor="invite-link">링크를 선택해 복사하세요</label><Input id="invite-link" readOnly value={copyFallback} onFocus={e => e.target.select()} /></div>}
      <div className="message-list" ref={scrollBox} tabIndex={0} role="log" aria-label="대화 내용" aria-live="polite" aria-relevant="additions" onScroll={() => { const box = scrollBox.current; if (box) stayAtBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 100; }}>
        {messages.length === 0 && <div className="empty-chat">{status === "connecting" || status === "authenticating" || status === "preparing" ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : null}<p>{status === "connected" ? "메시지를 입력하세요." : room.role === "host" ? "링크를 공유하고 기다려 주세요." : "연결하고 있어요."}</p></div>}
        {messages.map(message => <article className={`message ${message.mine ? "mine" : ""}`} key={message.id}>
          <span className="message-author">{message.nickname}{message.mine ? " · 나" : ""}</span>
          <div className="message-bubble">{message.text}</div>
          <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}{message.mine && ` · ${message.delivered ? "전달됨" : unconfirmed.has(message.id) ? "전달 확인 안 됨" : "전달 중"}`}</time>
        </article>)}
      </div>
      <form className="composer" onSubmit={event => { event.preventDefault(); void sendMessage(); }}>
        {error && <div className="error" role="alert" tabIndex={0}>{error}</div>}
        <div className="compose-row"><Textarea aria-label="메시지" autoComplete="off" spellCheck={false} placeholder={status === "connected" ? "메시지 입력" : "연결 대기 중"} maxLength={MAX_MESSAGE_CHARS} value={draft} readOnly={sending} disabled={status !== "connected"} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); } }} /><Button type="submit" className="send-button" aria-label="메시지 보내기" disabled={sending || status !== "connected" || !draft.trim()}>{sending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}</Button></div>
        <div className="composer-hint"><span>Enter 전송 · Shift+Enter 줄바꿈</span><span>{draft.length.toLocaleString()}/2,000</span></div>
      </form>
    </section>}
  </main>;
}
