import { useRef, useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { Invite } from "@/lib/protocol";
import { popupUrl, readWindowMode } from "@/lib/window-mode";

type Props = { joined: boolean; invite: Invite | null; inviteError: boolean; noteMode: boolean; fontSize: number };

export function WindowOptions({ joined, invite, inviteError, noteMode, fontSize }: Props) {
  const [compact] = useState(() => readWindowMode(window.location.search).compact);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const popup = useRef<Window | null>(null);
  const title = useRef<HTMLHeadingElement>(null);

  function openPopup() {
    if (joined || compact || inviteError) return;
    setError("");
    // Never navigate an existing popup: it may already contain a live room.
    if (popup.current && !popup.current.closed) {
      try { popup.current.focus(); } catch { /* Some browsers restrict focus. */ }
      setOpened(true);
      return;
    }
    setOpened(false);
    let next: Window | null = null;
    try {
      const url = popupUrl(window.location.href, invite, noteMode, fontSize);
      // Keep a handle for blocker detection; sever opener before loading the app.
      next = window.open("about:blank", "_blank", "popup=yes,width=400,height=560,resizable=yes,scrollbars=yes");
      if (!next) {
        setError("팝업이 차단됐어요. 주소창의 팝업 차단 표시에서 이 사이트를 허용한 뒤 다시 눌러 주세요.");
        return;
      }
      next.opener = null;
      next.location.replace(url);
      popup.current = next;
      setOpened(true);
    } catch {
      next?.close();
      setError("작은 창을 열지 못했어요. 현재 창에서 계속 사용할 수 있어요.");
      return;
    }
    try { next.focus(); } catch { /* The window is usable even if focus is denied. */ }
  }

  return <Dialog>
    <DialogTrigger asChild><Button variant="ghost" className="help-button" aria-label="창 사용 방식"><PanelsTopLeft aria-hidden="true" />창</Button></DialogTrigger>
    <DialogContent data-theme={noteMode ? "notes" : "default"} className="help-dialog window-dialog" showCloseButton={false} onOpenAutoFocus={event => { event.preventDefault(); title.current?.focus(); }}>
      <DialogHeader>
        <DialogTitle ref={title} tabIndex={-1}>창 사용 방식</DialogTitle>
        <DialogDescription>지금처럼 사용하거나 별도 창으로 시작하세요.</DialogDescription>
      </DialogHeader>
      <section className="window-option" aria-labelledby="popup-heading">
        <h2 id="popup-heading">작은 팝업</h2>
        <p>작게 열고 크기를 자유롭게 조절해요. 브라우저에 따라 주소 표시줄이 남거나 새 탭으로 열릴 수 있어요.</p>
        <Button variant="outline" className="window-launch" onClick={openPopup} disabled={joined || compact || inviteError}>작은 창 열기</Button>
        <p className="window-hint">{joined ? "대화 중에는 옮길 수 없어요. 다음 대화를 시작하기 전에 열어 주세요." : compact ? "이미 작은 창으로 열었어요. 이 창에서 계속 사용하세요." : inviteError ? "올바른 초대 링크를 연 뒤 다시 시도해 주세요." : "현재 테마·글자 크기·초대 링크가 새 창에 이어져요. 이름은 새 창에서 입력하세요."}</p>
        {opened && !joined && <p className="notice" role="status">새 창에서 시작하세요. 다시 누르면 먼저 연 창으로 돌아가요. 이 창은 닫아도 돼요.</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>
      <section className="window-option" aria-labelledby="app-heading">
        <h2 id="app-heading">Chrome 앱 창</h2>
        <p>탭·주소창·북마크 바 없이 별도 창으로 사용해요. 창의 제목 표시줄은 남을 수 있어요.</p>
        <ol className="window-steps">
          <li>일반 Chrome 창에서 이 사이트를 열어요.</li>
          <li><strong>⋮ → 전송, 저장 및 공유 → 페이지를 앱으로 설치…</strong>를 선택해요.</li>
          <li>설치된 앱 창에서 새 대화를 시작해요.</li>
        </ol>
        <p className="window-hint">새 대화를 시작하기 전에 설치하세요. 앱 창에서 방을 만든 뒤 링크를 공유하면 돼요. 초대받은 링크는 일반 창이나 작은 팝업에서 열어 주세요. 시크릿 모드나 회사 설정에 따라 설치 메뉴가 없을 수 있어요.</p>
      </section>
      <DialogClose asChild><Button variant="outline" className="help-close">현재 창에서 계속</Button></DialogClose>
    </DialogContent>
  </Dialog>;
}
