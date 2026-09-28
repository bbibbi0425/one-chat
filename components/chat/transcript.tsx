import { createRef, memo, PureComponent } from "react";
import { LoaderCircle } from "lucide-react";
import { StickerImage } from "@/components/chat/sticker-image";
import { getSticker } from "@/lib/stickers";
import type { ChatStatus } from "@/lib/peer-chat";
import type { Role } from "@/lib/protocol";
import type { DisplayMessage, TranscriptState } from "@/lib/transcript";
interface TranscriptProps { noteMode: boolean; fontSize: number; history: TranscriptState; status: ChatStatus; role: Role }
type ScrollSnapshot = { bottom: true } | { bottom: false; key: string | null; offset: number } | null;
const MessageRow = memo(function MessageRow({ message }: { message: DisplayMessage }) {
  const sticker = getSticker(message.text);
  const delivery = message.delivery === "delivered" ? "전달됨" : message.delivery === "unconfirmed" ? "전달 확인 안 됨" : "전달 중";
  return <article className={`message ${message.mine ? "mine" : ""}`} data-message-key={message.key}>
    <span className="message-author">{message.nickname}{message.mine ? " · 나" : ""}</span>
    <div className={`message-bubble${sticker ? " sticker-bubble" : ""}`}>{sticker ? <StickerImage sticker={sticker} /> : message.text}</div>
    <time dateTime={message.isoTime}>{message.timeLabel}{message.mine && <span className="message-delivery" data-delivery={message.delivery}>{` · ${delivery}`}</span>}</time>
  </article>;
});

// Snapshot the visible anchor before React removes old DOM rows, not after eviction.
export class Transcript extends PureComponent<TranscriptProps, Record<string, never>, ScrollSnapshot> {
  private scrollBox = createRef<HTMLDivElement>();
  componentDidMount() {
    const box = this.scrollBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }
  getSnapshotBeforeUpdate(previous: TranscriptProps): ScrollSnapshot {
    const box = this.scrollBox.current;
    const layoutChanged = previous.noteMode !== this.props.noteMode || previous.fontSize !== this.props.fontSize;
    if (!box || (previous.history === this.props.history && !layoutChanged)) return null;
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 60 || previous.history.sentRevision !== this.props.history.sentRevision) return { bottom: true };
    if (previous.history.trimmedCount === this.props.history.trimmedCount && !layoutChanged) return null;
    const retained = new Set(this.props.history.messages.map(message => message.key));
    const viewport = box.getBoundingClientRect();
    for (const row of box.querySelectorAll<HTMLElement>("[data-message-key]")) {
      if (!retained.has(row.dataset.messageKey!)) continue;
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > viewport.top && bounds.top < viewport.bottom) return { bottom: false, key: row.dataset.messageKey!, offset: bounds.top - viewport.top };
    }
    return { bottom: false, key: null, offset: 0 };
  }
  componentDidUpdate(...args: [TranscriptProps, Record<string, never>, ScrollSnapshot]) {
    const snapshot = args[2], box = this.scrollBox.current;
    if (!box || !snapshot) return;
    if (snapshot.bottom) { box.scrollTop = box.scrollHeight; return; }
    const anchor = Array.from(box.querySelectorAll<HTMLElement>("[data-message-key]")).find(row => row.dataset.messageKey === snapshot.key);
    if (anchor) {
      const bounds = anchor.getBoundingClientRect();
      // Theme or font changes can shorten the anchor row. Keep it in view.
      const offset = Math.max(snapshot.offset, -Math.max(0, bounds.height - 32));
      box.scrollTop += bounds.top - box.getBoundingClientRect().top - offset;
    } else box.scrollTop = 0;
  }
  render() {
    const { history, status, role, noteMode } = this.props;
    const connecting = status === "connecting" || status === "authenticating" || status === "preparing";
    return <div className="message-list" ref={this.scrollBox} tabIndex={0} role="log" aria-label="대화 내용" aria-live="polite" aria-relevant="additions">
      {history.messages.length === 0 && <div className="empty-chat">{connecting ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : null}<p>{status === "connected" ? (noteMode ? "내용을 입력하세요." : "메시지를 입력하세요.") : role === "host" ? "링크를 공유하고 기다려 주세요." : "연결하고 있어요."}</p></div>}
      {history.messages.map(message => <MessageRow key={message.key} message={message} />)}
    </div>;
  }
}
