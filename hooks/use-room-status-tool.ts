"use client";
import { useEffect, useRef } from "react";
type Snapshot = { joined: boolean; connection: string; expiresAt: number | null };
interface ToolContext {
  registerTool(tool: { name: string; description: string; inputSchema: object; annotations: object; execute(input: unknown): Snapshot }, options: { signal: AbortSignal }): void | Promise<void>;
}
// Optional read-only browser integration: never exposes invitations, keys, names or messages.
export function useRoomStatusTool(snapshot: Snapshot) {
  const current = useRef(snapshot);
  useEffect(() => { current.current = snapshot; }, [snapshot]);
  useEffect(() => {
    const context = (document as Document & { modelContext?: ToolContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    try {
      void Promise.resolve(context.registerTool({
        name: "get_room_status", description: "현재 대화방 입장 여부, 연결 상태와 만료 시간을 확인합니다. 대화 내용이나 초대 링크는 반환하지 않습니다.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute(input) {
          if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("EMPTY_OBJECT_REQUIRED");
          return { ...current.current };
        },
      }, { signal: lifecycle.signal })).catch(() => {});
    } catch { /* Unsupported experimental registration must not interrupt chat. */ }
    return () => lifecycle.abort();
  }, []);
}
