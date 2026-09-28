"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Clock3, Copy, Link2, LoaderCircle, LockKeyhole, LogOut, MessageCircle, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, friendlyError, RequestError } from "@/lib/client-api";
import { decryptMessage, encryptMessage, importRoomKey, inviteHash, parseInvite } from "@/lib/crypto";
import { useRoomStatusTool } from "@/hooks/use-room-status-tool";
import { drainMessages } from "@/lib/sync";
import type { MessagePage } from "@/lib/sync";
import { MAX_MESSAGE_CHARS, MAX_NICKNAME_CHARS, randomToken } from "@/lib/protocol";
import type { Envelope, Invite, PlainMessage, Room, Session, StoredMessage } from "@/lib/protocol";

type Connection = Session & { invite: Invite; key: CryptoKey; nickname: string; deadline: number };
type DisplayMessage = StoredMessage & { plain: PlainMessage | null };
function timeLabel(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, "0")).join(":");
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [nickname, setNickname] = useState("");
  const [connection, setConnection] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<Envelope | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("연결 중");
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  useRoomStatusTool({ joined: !!connection, connection: connection ? status : "입장 전", expiresAt: connection?.room.expiresAt ?? null });
  const lifecycle = useRef(0);
  const requestAbort = useRef<AbortController | null>(null);
  const sendLock = useRef(false);
  const scrollBox = useRef<HTMLDivElement>(null);
  const stayAtBottom = useRef(true);

  const clearChat = useCallback((message = "") => {
    lifecycle.current++;
    requestAbort.current?.abort();
    requestAbort.current = null;
    sendLock.current = false;
    setConnection(null); setMessages([]); setDraft(""); setPending(null);
    setSending(false); setBusy(false); setError(""); setNotice(message);
    setCopyFallback(""); setCopied(false); setNickname("");
  }, []);

  useEffect(() => {
    function readLocation() {
      clearChat();
      if (!window.location.hash) setInvite(null);
      else {
        try { setInvite(parseInvite(window.location.hash)); }
        catch { setInvite(null); setError("초대 링크가 올바르지 않아요. 링크 전체를 다시 받아 주세요."); }
      }
      setReady(true);
    }
    readLocation();
    window.addEventListener("hashchange", readLocation);
    const cancelOperations = () => { requestAbort.current?.abort(); lifecycle.current++; };
    return () => { window.removeEventListener("hashchange", readLocation); cancelOperations(); };
  }, [clearChat]);

  const endRoom = useCallback(() => {
    clearChat("방이 만료되었거나 더 이상 접근할 수 없어요. 새 방을 만들어 대화를 이어가세요.");
    setInvite(null);
    window.history.replaceState(null, "", window.location.pathname);
  }, [clearChat]);

  async function enterRoom() {
    if (busy || !nickname.trim()) return;
    const name = nickname.trim();
    const generation = ++lifecycle.current;
    requestAbort.current?.abort();
    const abort = new AbortController(); requestAbort.current = abort;
    setBusy(true); setError(""); setNotice("");
    try {
      if (!window.isSecureContext || !crypto.subtle) throw new Error("HTTPS_REQUIRED");
      let target = invite;
      if (!target) {
        const token = randomToken(); const key = randomToken();
        const result = await api<{ room: Room }>("/api/rooms", token, {}, abort.signal);
        if (generation !== lifecycle.current) return;
        target = { roomId: result.room.id, token, key };
        window.history.replaceState(null, "", inviteHash(target));
        setInvite(target);
      }
      const key = await importRoomKey(target.key);
      const session = await api<Session>(`/api/rooms/${target.roomId}/join`, target.token, {}, abort.signal);
      if (generation !== lifecycle.current) return;
      const deadline = performance.now() + Math.max(0, session.room.expiresAt - session.serverNow);
      setMessages([]); stayAtBottom.current = true; setRemaining(deadline - performance.now());
      setStatus("연결 중");
      setConnection({ ...session, invite: target, key, nickname: name, deadline });
    } catch (err) {
      if (generation === lifecycle.current) setError(err instanceof Error && err.message === "HTTPS_REQUIRED" ? "HTTPS 또는 localhost에서 접속해 주세요." : friendlyError(err));
    } finally { if (generation === lifecycle.current) setBusy(false); }
  }

  useEffect(() => {
    if (!connection) return;
    const generation = lifecycle.current;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let cursor = 0;
    let failures = 0;
    const active = () => !abort.signal.aborted && generation === lifecycle.current;
    async function poll() {
      try {
        cursor = await drainMessages(cursor,
          after => api<MessagePage>(`/api/rooms/${connection!.room.id}/messages?after=${after}`, connection!.sessionToken, undefined, abort.signal),
          async page => {
            const decoded = await Promise.all(page.messages.map(async message => {
              try { return { ...message, plain: await decryptMessage(connection!.key, connection!.room.id, message.senderId, message) }; }
              catch { return { ...message, plain: null }; }
            }));
            if (!active()) return;
            if (decoded.length) setMessages(current => {
              const ids = new Set(current.map(m => m.id));
              return [...current, ...decoded.filter(m => !ids.has(m.id))];
            });
          }, active);
        if (!active()) return;
        failures = 0; setStatus("연결됨");
        timer = setTimeout(poll, 1000);
      } catch (err) {
        if (!active()) return;
        if (err instanceof RequestError && [401, 403, 410].includes(err.status)) { endRoom(); return; }
        failures++; setStatus("연결 복구 중");
        const delay = err instanceof RequestError && err.status === 429 ? err.retryAfter * 1000 : Math.min(15000, 1000 * 2 ** Math.min(failures, 4));
        timer = setTimeout(poll, delay);
      }
    }
    void poll();
    const expiry = setInterval(() => {
      const left = connection.deadline - performance.now();
      if (left <= 0) endRoom(); else setRemaining(left);
    }, 1000);
    return () => { abort.abort(); clearTimeout(timer); clearInterval(expiry); };
  }, [connection, endRoom]);

  useEffect(() => {
    if (stayAtBottom.current && scrollBox.current) scrollBox.current.scrollTop = scrollBox.current.scrollHeight;
  }, [messages]);

  async function sendMessage() {
    if (!connection || sendLock.current || (!pending && !draft.trim())) return;
    const generation = lifecycle.current;
    sendLock.current = true; setSending(true); setError("");
    try {
      const envelope = pending ?? await encryptMessage(connection.key, connection.room.id, connection.senderId, { nickname: connection.nickname, text: draft });
      if (generation !== lifecycle.current) return;
      setPending(envelope);
      await api(`/api/rooms/${connection.room.id}/messages`, connection.sessionToken, envelope, requestAbort.current?.signal);
      if (generation !== lifecycle.current) return;
      setPending(null); setDraft(""); stayAtBottom.current = true;
      // Only fetched pages advance the cursor; a send response can skip unseen incoming messages.
    } catch (err) {
      if (generation !== lifecycle.current) return;
      if (err instanceof RequestError && [401, 403, 410].includes(err.status)) endRoom();
      else {
        if (err instanceof RequestError && [400, 409, 413, 415].includes(err.status)) setPending(null);
        setError(friendlyError(err));
      }
    } finally {
      if (generation === lifecycle.current) { sendLock.current = false; setSending(false); }
    }
  }
  async function copyLink() {
    if (!connection) return;
    const generation = lifecycle.current;
    const link = `${window.location.origin}${window.location.pathname}${inviteHash(connection.invite)}`;
    try { await navigator.clipboard.writeText(link); if (generation === lifecycle.current) setCopied(true); }
    catch { if (generation === lifecycle.current) setCopyFallback(link); }
  }
  function leaveRoom() {
    clearChat("대화방에서 나왔어요. 초대 링크가 있으면 만료 전까지 다시 입장할 수 있어요.");
    setInvite(null); window.history.replaceState(null, "", window.location.pathname);
  }

  return <main className="app-shell">
    <header className="site-header">
      <div className="brand"><span className="brand-icon"><MessageCircle size={21} /></span> one-chat<span className="brand-dot">.</span></div>
      <span className="header-note"><LockKeyhole size={14} /> 링크로 연결되는 작은 대화방</span>
    </header>
    {!connection ? <section className="welcome-layout">
      <div className="welcome-copy">
        <span className="eyebrow">JUST A LINK. JUST US.</span>
        <h1>가볍게 만나고,<br /><span>오늘만 이야기해요.</span></h1>
        <p className="lead">가입 없이 닉네임 하나로.<br />링크를 나누면 우리만의 대화가 시작돼요.</p>
        <div className="welcome-facts"><span><Clock3 size={18} /> 생성 후 9시간</span><span><ShieldCheck size={18} /> 메시지 암호화</span></div>
        <div className="small-note"><span className="note-line" />오래 남길 필요 없는, 일상의 짧은 이야기.</div>
      </div>
      <div className="entry-card">
        <div className="entry-icon"><MessageCircle size={28} /></div>
        <h2>{invite ? "초대받은 방에 들어가기" : "우리만의 대화 시작하기"}</h2>
        <p>{invite ? "대화에서 사용할 이름만 정해 주세요." : "방을 만들고, 함께할 사람에게 링크를 보내세요."}</p>
        <form onSubmit={event => { event.preventDefault(); void enterRoom(); }}>
          <label htmlFor="nickname">닉네임</label>
          <Input id="nickname" className="name-input" autoComplete="off" maxLength={MAX_NICKNAME_CHARS} value={nickname} onChange={event => setNickname(event.target.value)} placeholder="어떤 이름으로 이야기할까요?" required disabled={busy || !ready} />
          <div className="field-hint">최대 20자 · 방에 있는 사람들에게 보여요</div>
          <Button className="primary-action" type="submit" disabled={!ready || busy || !nickname.trim()}>{busy ? <><LoaderCircle className="spin" /> 연결하고 있어요</> : <>{invite ? "대화방 입장하기" : "새 대화방 만들기"}<ArrowRight size={18} /></>}</Button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {invite && <Button variant="ghost" className="new-room-link" onClick={leaveRoom} disabled={busy}>새 방을 만들래요</Button>}
        <div className="entry-footer"><Link2 size={15} /><span>초대 링크가 있는 누구나 들어올 수 있어요.<br />함께할 사람에게만 공유해 주세요.</span></div>
      </div>
    </section> : <section className="chat-layout">
      <aside className="room-sidebar">
        <span className="eyebrow">TODAY’S ROOM</span>
        <h1>함께 있는<br />이 시간.</h1>
        <div className="expiry-card"><span><Clock3 size={16} /> 방 만료까지</span><strong>{timeLabel(remaining)}</strong><p>방을 만든 시점부터 9시간.<br />시간이 지나면 대화에 접근할 수 없어요.</p></div>
        <Button variant="outline" className="copy-button" onClick={() => void copyLink()}>{copied ? <Check /> : <Copy />}{copied ? "초대 링크 복사됨" : "초대 링크 복사"}</Button>
        {copyFallback && <div className="manual-copy"><label htmlFor="invite-link">링크를 선택해서 복사해 주세요</label><Input id="invite-link" readOnly value={copyFallback} onFocus={e => e.target.select()} /></div>}
        <p className="sidebar-note">링크에는 대화를 읽는 키가 포함돼요. 안전하게 공유해 주세요.</p>
        <Button variant="ghost" className="leave-button" onClick={leaveRoom}><LogOut /> 방 나가기</Button>
      </aside>
      <div className="chat-panel">
        <div className="chat-header"><div><h2>오늘의 대화</h2><span className="nickname-tag">{connection.nickname} 님으로 참여 중</span></div><span className={`connection-state ${status === "연결됨" ? "online" : ""}`}><i />{status}</span></div>
        <div className="message-list" ref={scrollBox} role="log" aria-label="대화 내용" aria-live="polite" aria-relevant="additions" onScroll={() => { const box = scrollBox.current; if (box) stayAtBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 100; }}>
          <div className="chat-start"><LockKeyhole size={14} /> 메시지는 브라우저에서 암호화돼요</div>
          {messages.length === 0 && <div className="empty-chat"><span><MessageCircle size={32} /></span><h3>첫 이야기를 건네보세요.</h3><p>초대 링크를 공유하고<br />편하게 대화를 시작하세요.</p></div>}
          {messages.map(message => <article className={`message ${message.senderId === connection.senderId ? "mine" : ""}`} key={message.id}>
            <span className="message-author">{message.plain?.nickname ?? "확인할 수 없는 메시지"}{message.senderId === connection.senderId ? " · 나" : ""}</span>
            <div className={`message-bubble ${!message.plain ? "unreadable" : ""}`}>{message.plain?.text ?? "메시지를 복호화할 수 없어요. 초대 링크가 올바른지 확인해 주세요."}</div>
            <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })}</time>
          </article>)}
        </div>
        <form className="composer" onSubmit={event => { event.preventDefault(); void sendMessage(); }}>
          {error && <div className="error" role="alert">{error}{pending && " 아래 버튼으로 같은 메시지를 다시 전송할 수 있어요."}</div>}
          <div className="compose-row"><Textarea aria-label="메시지" placeholder="메시지를 입력하세요" maxLength={MAX_MESSAGE_CHARS} value={draft} disabled={sending || !!pending} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void sendMessage(); } }} /><Button type="submit" className="send-button" aria-label={pending && !sending ? "메시지 다시 전송" : "메시지 보내기"} disabled={sending || (!pending && !draft.trim())}>{sending ? <LoaderCircle className="spin" /> : pending ? "재전송" : <Send size={19} />}</Button></div>
          <div className="composer-hint"><span>Enter 전송 · Shift + Enter 줄바꿈</span><span>{draft.length.toLocaleString()} / 2,000</span></div>
        </form>
      </div>
    </section>}
    <footer className="site-footer"><span>one-chat · a little room for today</span><details><summary>개인정보와 보관 안내</summary><div>대화는 생성 후 9시간 동안 접근할 수 있어요. 만료된 방과 암호문은 운영 DB에서 주기적으로 삭제되지만 서비스 백업이나 상대방이 저장한 복사본은 남을 수 있어요. 암호화는 회사 기기의 화면 수집이나 네트워크 접속 기록을 숨기지 않아요. 닉네임은 실제 신원을 인증하지 않아요.</div></details></footer>
  </main>;
}
