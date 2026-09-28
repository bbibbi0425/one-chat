import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import Peer from "peerjs";
import { Check, Copy, FileText, Info, LogOut, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import noteIcon from "@/assets/note-icon.svg?inline";
import { Composer } from "@/components/chat/composer";
import { RoomTimer } from "@/components/chat/room-timer";
import { Transcript } from "@/components/chat/transcript";
import { EMPTY_TRANSCRIPT, MAX_RETAINED_MESSAGES, transcriptReducer } from "@/lib/transcript";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PeerChat } from "@/lib/peer-chat";
import type { ChatStatus } from "@/lib/peer-chat";
import { createInvite, inviteHash, parseInvite, MAX_NICKNAME_CHARS } from "@/lib/protocol";
import type { Invite, Role } from "@/lib/protocol";
import { useRoomStatusTool } from "@/hooks/use-room-status-tool";

type RoomView = { invite: Invite; role: Role; nickname: string; chat: PeerChat };
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
export default function Home() {
  const [noteMode, setNoteMode] = useState(false);
  const [entry, setEntry] = useState(readInvite);
  const [nickname, setNickname] = useState("");
  const [room, setRoom] = useState<RoomView | null>(null);
  const [status, setStatus] = useState<ChatStatus>("preparing");
  const [remoteName, setRemoteName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [history, dispatch] = useReducer(transcriptReducer, EMPTY_TRANSCRIPT);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState("");
  const active = useRef<PeerChat | null>(null);
  const generation = useRef(0);

  // Presentation only: no storage, navigation or transport effects when switching.
  useEffect(() => {
    const previousTitle = document.title;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const previousIcon = icon?.getAttribute("href");
    document.title = noteMode ? "메모" : "one-chat";
    if (icon) icon.href = noteMode ? noteIcon : `${import.meta.env.BASE_URL}favicon.svg`;
    return () => { document.title = previousTitle; if (icon && previousIcon != null) icon.setAttribute("href", previousIcon); };
  }, [noteMode]);

  const helpTitle = useRef<HTMLHeadingElement>(null);
  useRoomStatusTool({ joined: !!room, connection: room ? labels[status] : "입장 전", expiresAt: room?.invite.expiresAt ?? null });

  const clearView = useCallback((message: string) => {
    setRoom(null); dispatch({ type: "clear" }); setNickname(""); setRemoteName("");
    setError(""); setNotice(message);
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
    return () => {
      window.removeEventListener("hashchange", hashchange); window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", pageshow);
      stopTransport();
    };
  }, [end, stopTransport]);

  function enterRoom() {
    if (active.current || !nickname.trim()) return;
    setError(""); setNotice("");
    if (!window.isSecureContext || !crypto.subtle || !window.RTCPeerConnection) { setError("HTTPS 또는 localhost에서 최신 브라우저로 접속해 주세요."); return; }
    const current = ++generation.current;
    try {
      const invite = entry.invite ?? createInvite();
      if (invite.expiresAt <= Date.now()) { setError(explanation("ROOM_EXPIRED")); return; }
      const target: Omit<RoomView, "chat"> = { invite, role: entry.invite ? "guest" : "host", nickname: nickname.trim() };
      setEntry({ invite: null, error: "" }); setStatus("preparing"); dispatch({ type: "clear" });
      const chat = new PeerChat({ ...target, createPeer: (id, options) => new Peer(id, options),
        onStatus: (next, name) => { if (generation.current === current) { setStatus(next); if (name) setRemoteName(name); } },
        onMessage: message => { if (generation.current === current) dispatch({ type: "append", message }); },
        onDelivered: id => { if (generation.current === current) dispatch({ type: "delivered", id }); },
        onUnconfirmed: id => { if (generation.current === current) dispatch({ type: "unconfirmed", id }); },
        onEnd: reason => { if (generation.current === current) { generation.current++; active.current = null; clearView(explanation(reason)); } },
      });
      active.current = chat; setRoom({ ...target, chat }); stripHash(); chat.start();
    } catch { end("CONNECTION_FAILED"); }
  }
  const sendMessage = useCallback(async (text: string) => {
    const chat = active.current;
    if (!chat) throw new Error("DISCONNECTED");
    await chat.send(text);
  }, []);
  async function copyLink() {
    if (!room || room.role !== "host") return;
    const current = generation.current;
    const link = `${window.location.origin}${window.location.pathname}${inviteHash(room.invite)}`;
    try { await navigator.clipboard.writeText(link); if (generation.current === current) setCopied(true); }
    catch { if (generation.current === current) setCopyFallback(link); }
  }
  return <main className={`app-shell ${room ? "in-room" : "at-entry"}`} data-theme={noteMode ? "notes" : "default"}>
    <header className="site-header">
      <span className="brand">{noteMode ? <><FileText size={16} aria-hidden="true" />메모</> : "one-chat"}</span>
      <div className="site-actions">
        <ToggleGroup data-theme-switch type="single" value={noteMode ? "notes" : "default"} onValueChange={value => { if (value === "notes" || value === "default") setNoteMode(value === "notes"); }} className="theme-switch" aria-label="화면 테마">
          <ToggleGroupItem value="default" className="theme-option" aria-label="기본 테마">기본</ToggleGroupItem>
          <ToggleGroupItem value="notes" className="theme-option" aria-label="메모 테마">메모</ToggleGroupItem>
        </ToggleGroup>
      <Dialog>
        <DialogTrigger asChild><Button variant="ghost" className="help-button"><Info aria-hidden="true" />안내</Button></DialogTrigger>
        <DialogContent data-theme={noteMode ? "notes" : "default"} className="help-dialog" showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); helpTitle.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle ref={helpTitle} tabIndex={-1}>사용 안내</DialogTitle>
            <DialogDescription>두 사람 전용 · 최대 9시간</DialogDescription>
          </DialogHeader>
          <div className="help-copy">
            <p>방을 만든 뒤 초대 링크를 한 사람에게 공유하세요. 둘 다 이 창을 열어 둔 동안 대화할 수 있어요.</p>
            <p>새로고침·나가기·연결 종료 시 대화가 끝나며 이전 내용은 다시 불러올 수 없어요. 연결 종료 감지에는 시간이 걸릴 수 있어요.</p>
            <p>글과 스티커를 합쳐 최근 {MAX_RETAINED_MESSAGES}개만 남겨요. 새 메시지로 한도를 넘으면 가장 오래된 내용부터 지우며 복원할 수 없어요. 지워져도 방과 연결은 유지돼요.</p>
            <p>메시지는 이 탭의 메모리에만 두고 앱의 DB·브라우저 저장소에 기록하지 않아요. ‘전달됨’은 상대 앱에 도착했다는 뜻이며 읽음 표시는 아니에요.</p>
            <p>초대 링크에는 비밀 키가 포함돼요. 링크를 가진 사람이 참여할 수 있으며 닉네임은 신원 인증이 아니에요. 9시간 만료는 각 브라우저에서 적용해요.</p>
            <p>연결에 PeerJS Cloud와 Google STUN을 사용하며 IP·접속 정보가 남을 수 있어요. 회사 기기의 기록이나 상대방의 복사본까지 지우거나 숨기는 기능은 아니에요.</p>
          </div>
          <DialogClose asChild><Button variant="outline" className="help-close">닫기</Button></DialogClose>
        </DialogContent>
      </Dialog>
      </div>
    </header>
    {!room ? <section className="entry-layout" aria-labelledby="entry-title">
      <div className="entry-card">
        <h1 id="entry-title">{noteMode ? (entry.invite ? "메모 열기" : "새 메모") : (entry.invite ? "입장" : "새 방")}</h1>
        <form onSubmit={event => { event.preventDefault(); enterRoom(); }}>
          <label htmlFor="nickname">{noteMode ? "표시 이름" : "닉네임"}</label>
          <Input id="nickname" className="name-input" autoComplete="off" spellCheck={false} maxLength={MAX_NICKNAME_CHARS} value={nickname} onChange={event => setNickname(event.target.value)} placeholder="20자 이내" required />
          <Button className="primary-action" type="submit" disabled={!nickname.trim() || !!entry.error}>{noteMode ? (entry.invite ? "열기" : "시작") : (entry.invite ? "입장하기" : "방 만들기")}</Button>
        </form>
        {(error || entry.error) && <p className="error" role="alert">{error || entry.error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {(entry.invite || entry.error) && <Button variant="ghost" className="new-room-link" onClick={() => { setEntry({ invite: null, error: "" }); setError(""); }}>{noteMode ? "새 메모 시작" : "새 방 만들기"}</Button>}
        <p className="entry-hint">{entry.invite ? "초대한 사람이 창을 열어 두어야 해요." : noteMode ? "시작한 뒤 링크를 공유하세요." : "방을 만든 뒤 초대 링크를 공유하세요."}</p>
      </div>
    </section> : <section className="chat-panel" aria-label="대화방" key={room.invite.hostId}>
      <header className="chat-header">
        <div className="chat-toolbar">
          <div className="room-identity">
            <h1 title={noteMode ? "제목 없는 메모" : remoteName || "연결 대기"}>{noteMode ? "제목 없는 메모" : remoteName || "연결 대기"}</h1>
            <span className="nickname-tag" title={noteMode ? `${room.nickname}${remoteName ? ` · ${remoteName}` : ""}` : room.nickname}>{noteMode ? `${room.nickname}${remoteName ? ` · ${remoteName}` : ""}` : `나: ${room.nickname}`}</span>
          </div>
          <div className="room-actions">
            {room.role === "host" && status !== "connected" && <Button variant="outline" className="tool-button" disabled={status === "preparing"} aria-label={copied ? "초대 링크 다시 복사" : "초대 링크 복사"} title="초대 링크 복사" onClick={() => void copyLink()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "복사됨" : "링크"}</Button>}
            <Button variant="ghost" className="tool-button" onClick={() => end()} aria-label="방 나가기" title="방 나가기">{noteMode ? <X aria-hidden="true" /> : <LogOut aria-hidden="true" />}{noteMode ? "닫기" : "나가기"}</Button>
          </div>
        </div>
        <div className="room-meta">
          <span role="status" className={`connection-state ${status === "connected" ? "online" : ""}`}><i aria-hidden="true" />{labels[status]}</span>
          <span className="history-limit" title="오래된 내용부터 자동 삭제되며 복원되지 않아요">최근 {MAX_RETAINED_MESSAGES}개 유지</span>
          <RoomTimer chat={room.chat} />
        </div>
      </header>
      {copyFallback && status !== "connected" && <div className="manual-copy"><label htmlFor="invite-link">링크를 선택해 복사하세요</label><Input id="invite-link" readOnly value={copyFallback} onFocus={e => e.target.select()} /></div>}
      <Transcript history={history} status={status} role={room.role} noteMode={noteMode} />
      <Composer connected={status === "connected"} onSend={sendMessage} noteMode={noteMode} />
    </section>}
  </main>;
}
