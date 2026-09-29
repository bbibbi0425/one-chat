import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import Peer from "peerjs";
import { Check, Copy, FileText, Info, LogOut, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import noteIcon from "@/assets/note-icon.svg?inline";
import { Composer } from "@/components/chat/composer";
import { RoomTimer } from "@/components/chat/room-timer";
import { Transcript } from "@/components/chat/transcript";
import { WindowOptions } from "@/components/chat/window-options";
import { MIN_FONT_SIZE, MAX_FONT_SIZE, readWindowMode } from "@/lib/window-mode";
import { EMPTY_TRANSCRIPT, MAX_RETAINED_MESSAGES, transcriptReducer } from "@/lib/transcript";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { PeerChat } from "@/lib/peer-chat";
import type { ChatStatus } from "@/lib/peer-chat";
import { ROOM_TTL_MS, inviteHash, parseInvite, MAX_NICKNAME_CHARS } from "@/lib/protocol";
import type { Invite, Role } from "@/lib/protocol";
import { createRoomCode, deriveCodeRoom, normalizeRoomCode } from "@/lib/code-room";
import { useRoomStatusTool } from "@/hooks/use-room-status-tool";

type RoomView = { invite: Invite; role: Role; nickname: string; chat: PeerChat; code: string };
const labels: Record<ChatStatus, string> = { preparing: "준비 중", waiting: "대기 중", connecting: "연결 중", authenticating: "확인 중", connected: "연결됨" };
function explanation(reason: string) {
  if (reason === "ROOM_FULL") return "이미 두 사람이 이 코드를 사용 중이에요. 다른 탭이나 작은 창이 열려 있는지도 확인해 주세요. 이미 닫았다면 잠시 뒤 다시 시도하세요.";
  if (reason === "SIGNAL_UNAVAILABLE" || reason === "SIGNAL_TIMEOUT") return "연결 서비스에 접속하지 못했거나 접속이 끊겼어요. 네트워크에서 연결 서비스 접속을 허용하는지 확인해 주세요. [연결 서비스]";
  if (reason === "RTC_UNAVAILABLE") return "이 브라우저에서 실시간 연결을 시작하지 못했어요. 브라우저 지원 여부나 관리 정책을 확인해 주세요. [직접 연결 시작]";
  if (reason === "RTC_TIMEOUT") return "상대방을 찾았지만 직접 연결하지 못했어요. 회사망·VMware의 네트워크 제한일 수 있으며, 입장 코드나 주소를 바꾸는 것만으로는 해결되지 않아요. [직접 연결]";
  if (reason === "ROOM_EXPIRED") return "방의 9시간이 끝났어요. 다시 입장해 새 대화를 시작해 주세요.";
  if (reason === "LEFT_ROOM") return "방에서 나왔어요. 이전 대화는 다시 불러올 수 없어요.";
  if (reason === "AUTH_FAILED" || reason === "AUTH_TIMEOUT" || reason === "INVALID_FRAME") return "연결 정보를 확인하지 못했어요. 같은 입장 코드 또는 초대 링크를 사용했는지 확인해 주세요. [연결 확인]";
  if (reason === "ROOM_UNAVAILABLE") return "상대방이 나갔거나 아직 준비되지 않았어요. 같은 코드로 다시 입장해 주세요. 초대 링크로 입장했다면 초대한 사람이 창을 열어 두어야 해요.";
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
  const [noteMode, setNoteMode] = useState(() => readWindowMode(window.location.search).noteMode);
  const [fontSize, setFontSize] = useState(() => readWindowMode(window.location.search).fontSize);
  const [entry, setEntry] = useState(readInvite);
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const joinPending = useRef(false);
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
    setRoomCode(""); setCodeCopied(false); setJoining(false); joinPending.current = false;
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

  async function enterRoom() {
    if (active.current || joinPending.current || !nickname.trim()) return;
    setError(""); setNotice("");
    if (!window.isSecureContext || !crypto.subtle || !window.RTCPeerConnection) { setError("HTTPS 또는 localhost에서 최신 브라우저로 접속해 주세요."); return; }
    joinPending.current = true; setJoining(true);
    const current = ++generation.current, name = nickname.trim();
    try {
      const code = entry.invite ? "" : normalizeRoomCode(roomCode).match(/.{4}/g)!.join("-");
      const fixed = code ? await deriveCodeRoom(code) : null;
      if (generation.current !== current) return;
      const invite: Invite = entry.invite ?? { version: 2, hostId: fixed!.hostId, key: fixed!.key, expiresAt: Date.now() + ROOM_TTL_MS };
      if (invite.expiresAt <= Date.now()) { setError(explanation("ROOM_EXPIRED")); return; }
      const target: Omit<RoomView, "chat"> = { invite, role: entry.invite ? "guest" : "host", nickname: name, code };
      setEntry({ invite: null, error: "" }); setStatus("preparing"); dispatch({ type: "clear" });
      const chat = new PeerChat({ role: target.role, invite, nickname: name, fixedGuestId: fixed?.guestId, createPeer: (id, options) => new Peer(id, options),
        onRoom: (role, nextInvite) => { if (generation.current === current) setRoom(value => value?.chat === chat ? { ...value, role, invite: nextInvite } : value); },
        onStatus: (next, remote) => { if (generation.current === current) { setStatus(next); if (remote) setRemoteName(remote); } },
        onMessage: message => { if (generation.current === current) dispatch({ type: "append", message }); },
        onDelivered: id => { if (generation.current === current) dispatch({ type: "delivered", id }); },
        onUnconfirmed: id => { if (generation.current === current) dispatch({ type: "unconfirmed", id }); },
        onEnd: reason => { if (generation.current === current) { generation.current++; active.current = null; clearView(explanation(reason)); } },
      });
      active.current = chat; setRoom({ ...target, chat }); setRoomCode(""); setCodeCopied(false); stripHash(); chat.start();
    } catch (cause) {
      if (generation.current !== current) return;
      if (cause instanceof Error && cause.message === "INVALID_ROOM_CODE") setError("입장 코드는 20자리 영문·숫자예요. 처음이라면 한 사람이 ‘코드 만들기’를 눌러 공유해 주세요.");
      else end("CONNECTION_FAILED");
    } finally {
      if (generation.current === current) { joinPending.current = false; setJoining(false); }
    }
  }
  async function copyEntryCode() {
    const value = roomCode;
    try { await navigator.clipboard.writeText(value); if (!joinPending.current && !active.current) setCodeCopied(true); }
    catch { setError("입장 코드 입력칸의 내용을 선택해 직접 복사해 주세요."); }
  }
  const sendMessage = useCallback(async (text: string) => {
    const chat = active.current;
    if (!chat) throw new Error("DISCONNECTED");
    await chat.send(text);
  }, []);
  async function copyLink() {
    if (!room || (!room.code && room.role !== "host")) return;
    const current = generation.current;
    const link = room.code || `${window.location.origin}${window.location.pathname}${inviteHash(room.invite)}`;
    try { await navigator.clipboard.writeText(link); if (generation.current === current) setCopied(true); }
    catch { if (generation.current === current) setCopyFallback(link); }
  }
  return <main className={`app-shell ${room ? "in-room" : "at-entry"}`} data-theme={noteMode ? "notes" : "default"} style={{ "--chat-font-size": `${fontSize / 16}rem` } as CSSProperties}>
    <header className="site-header">
      <span className="brand">{noteMode ? <><FileText size={16} aria-hidden="true" />메모</> : "one-chat"}</span>
      <div className="site-actions">
        <ToggleGroup data-theme-switch type="single" value={noteMode ? "notes" : "default"} onValueChange={value => { if (value === "notes" || value === "default") setNoteMode(value === "notes"); }} className="theme-switch" aria-label="화면 테마">
          <ToggleGroupItem value="default" className="theme-option" aria-label="기본 테마">기본</ToggleGroupItem>
          <ToggleGroupItem value="notes" className="theme-option" aria-label="메모 테마">메모</ToggleGroupItem>
        </ToggleGroup>
        <div className="font-size-controls" data-font-size-switch role="group" aria-label="글자 크기">
          <Button type="button" variant="ghost" className="font-size-button" aria-label="글자 작게" title="글자 작게" disabled={fontSize <= MIN_FONT_SIZE} onClick={() => setFontSize(size => Math.max(MIN_FONT_SIZE, size - 1))}>A−</Button>
          <output className="font-size-value" aria-label={`글자 크기 ${fontSize}픽셀`} aria-live="polite" aria-atomic="true">{fontSize}</output>
          <Button type="button" variant="ghost" className="font-size-button" aria-label="글자 크게" title="글자 크게" disabled={fontSize >= MAX_FONT_SIZE} onClick={() => setFontSize(size => Math.min(MAX_FONT_SIZE, size + 1))}>A+</Button>
        </div>
        <WindowOptions joined={!!room || joining} invite={entry.invite} inviteError={!!entry.error} noteMode={noteMode} fontSize={fontSize} />
      <Dialog>
        <DialogTrigger asChild><Button variant="ghost" className="help-button"><Info aria-hidden="true" />안내</Button></DialogTrigger>
        <DialogContent data-theme={noteMode ? "notes" : "default"} className="help-dialog" showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); helpTitle.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle ref={helpTitle} tabIndex={-1}>사용 안내</DialogTitle>
            <DialogDescription>두 사람 전용 · 최대 9시간</DialogDescription>
          </DialogHeader>
          <div className="help-copy">
            <p>같은 사이트에서 닉네임과 같은 입장 코드를 입력하세요. 먼저 들어온 사람이 기다리고 두 번째 사람이 자동으로 연결돼요. 처음에는 한 사람만 코드를 만들어 공유하세요.</p>
            <p>새로고침·나가기·연결 종료 시 대화가 끝나며 이전 내용은 다시 불러올 수 없어요. 연결 종료 감지에는 시간이 걸릴 수 있어요.</p>
            <p>글과 스티커를 합쳐 최근 {MAX_RETAINED_MESSAGES}개만 남겨요. 새 메시지로 한도를 넘으면 가장 오래된 내용부터 지우며 복원할 수 없어요. 지워져도 방과 연결은 유지돼요.</p>
            <p>메시지는 이 탭의 메모리에만 두고 앱의 DB·브라우저 저장소에 기록하지 않아요. ‘전달됨’은 상대 앱에 도착했다는 뜻이며 읽음 표시는 아니에요.</p>
            <p>입장 코드는 같은 방을 찾고 서로 연결을 확인하는 비밀 정보예요. 코드 하나당 동시에 두 자리만 사용하며, 코드를 아는 사람은 참여할 수 있어요. 같은 사람이 탭 두 개를 열어도 두 자리로 계산해요. 코드를 잊으면 앱에서 복구할 수 없어요.</p>
            <p>연결에 PeerJS Cloud와 Google STUN을 사용하며 IP·접속 정보가 남을 수 있어요. 직접 연결이 제한된 회사망에서는 사용할 수 없을 수 있어요. 회사 기기의 기록이나 상대방의 복사본까지 지우거나 숨기는 기능은 아니에요.</p>
          </div>
          <DialogClose asChild><Button variant="outline" className="help-close">닫기</Button></DialogClose>
        </DialogContent>
      </Dialog>
      </div>
    </header>
    {!room ? <section className="entry-layout" aria-labelledby="entry-title">
      <div className="entry-card">
        <h1 id="entry-title">{noteMode ? "메모 열기" : "입장"}</h1>
        <form onSubmit={event => { event.preventDefault(); void enterRoom(); }}>
          <label htmlFor="nickname">{noteMode ? "표시 이름" : "닉네임"}</label>
          <Input id="nickname" className="name-input" autoComplete="off" spellCheck={false} maxLength={MAX_NICKNAME_CHARS} value={nickname} disabled={joining} onChange={event => setNickname(event.target.value)} placeholder="20자 이내" required />
          {!entry.invite && !entry.error && <div className="code-field">
            <label htmlFor="room-code">입장 코드</label>
            <Input id="room-code" className="name-input code-input" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={64} value={roomCode} disabled={joining} onChange={event => { setRoomCode(event.target.value); setCodeCopied(false); }} placeholder="두 사람이 같은 코드 입력" aria-describedby="code-hint" required />
            <div className="code-actions">
              <Button type="button" variant="ghost" disabled={joining} onClick={() => { setRoomCode(createRoomCode()); setCodeCopied(false); setError(""); }}>코드 만들기</Button>
              <Button type="button" variant="ghost" disabled={joining || !roomCode.trim()} onClick={() => void copyEntryCode()}>{codeCopied ? "복사됨" : "코드 복사"}</Button>
            </div>
            <p className="entry-hint code-hint" id="code-hint">처음에는 한 사람만 코드를 만들어 공유하세요. 다음에도 같은 코드를 쓰면 돼요.</p>
          </div>}
          <Button className="primary-action" type="submit" disabled={joining || !nickname.trim() || !!entry.error || (!entry.invite && !roomCode.trim())}>{joining ? "준비 중…" : noteMode ? "열기" : "입장하기"}</Button>
        </form>
        {(error || entry.error) && <p className="error" role="alert">{error || entry.error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        {(entry.invite || entry.error) && <Button variant="ghost" className="new-room-link" onClick={() => { setEntry({ invite: null, error: "" }); setError(""); }}>{noteMode ? "입장 코드로 열기" : "입장 코드로 시작"}</Button>}
        <p className="entry-hint">{entry.invite ? "이전 초대 링크로 입장해요. 초대한 사람이 창을 열어 두어야 해요." : "같은 코드로 최대 2명 · 둘 다 창을 열어 두세요."}</p>
      </div>
    </section> : <section className="chat-panel" aria-label="대화방" key={room.invite.hostId}>
      <header className="chat-header">
        <div className="chat-toolbar">
          <div className="room-identity">
            <h1 title={noteMode ? "제목 없는 메모" : remoteName || "연결 대기"}>{noteMode ? "제목 없는 메모" : remoteName || "연결 대기"}</h1>
            <span className="nickname-tag" title={noteMode ? `${room.nickname}${remoteName ? ` · ${remoteName}` : ""}` : room.nickname}>{noteMode ? `${room.nickname}${remoteName ? ` · ${remoteName}` : ""}` : `나: ${room.nickname}`}</span>
          </div>
          <div className="room-actions">
            {(!!room.code || room.role === "host") && status !== "connected" && <Button variant="outline" className="tool-button" disabled={status === "preparing"} aria-label={room.code ? "입장 코드 복사" : "초대 링크 복사"} title={room.code ? "입장 코드 복사" : "초대 링크 복사"} onClick={() => void copyLink()}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}{copied ? "복사됨" : room.code ? "코드" : "링크"}</Button>}
            <Button variant="ghost" className="tool-button" onClick={() => end()} aria-label="방 나가기" title="방 나가기">{noteMode ? <X aria-hidden="true" /> : <LogOut aria-hidden="true" />}{noteMode ? "닫기" : "나가기"}</Button>
          </div>
        </div>
        <div className="room-meta">
          <span role="status" className={`connection-state ${status === "connected" ? "online" : ""}`}><i aria-hidden="true" />{labels[status]}</span>
          <span className="history-limit" title="오래된 내용부터 자동 삭제되며 복원되지 않아요">최근 {MAX_RETAINED_MESSAGES}개 유지</span>
          <RoomTimer chat={room.chat} />
        </div>
      </header>
      {copyFallback && status !== "connected" && <div className="manual-copy"><label htmlFor="invite-link">{room.code ? "코드를 선택해 복사하세요" : "링크를 선택해 복사하세요"}</label><Input id="invite-link" readOnly value={copyFallback} onFocus={e => e.target.select()} /></div>}
      <Transcript history={history} status={status} role={room.role} noteMode={noteMode} fontSize={fontSize} codeRoom={!!room.code} />
      <Composer connected={status === "connected"} onSend={sendMessage} noteMode={noteMode} />
    </section>}
  </main>;
}
