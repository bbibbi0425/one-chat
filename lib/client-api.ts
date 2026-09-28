export class RequestError extends Error {
  status: number;
  retryAfter: number;
  constructor(status: number, code: string, retryAfter = 1) { super(code); this.status = status; this.retryAfter = retryAfter; }
}
export async function api<T>(path: string, token: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(12000);
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", credentials: "omit", redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new RequestError(response.status, typeof data.error === "string" ? data.error : "REQUEST_FAILED", Math.min(120, Math.max(1, Number(response.headers.get("retry-after")) || 1)));
  return data as T;
}
export function friendlyError(error: unknown): string {
  if (error instanceof RequestError) {
    if (error.message === "ROOM_FULL") return "이 방의 메시지 한도에 도달했어요. 새 방을 만들어 대화를 이어가세요.";
    if ([400, 413].includes(error.status)) return "메시지가 너무 길거나 형식이 맞지 않아요. 내용을 수정한 뒤 전송해 주세요.";
    if (error.status === 403 || error.status === 410) return "방이 만료되었거나 초대 링크를 사용할 수 없어요.";
    if (error.status === 429) return "요청이 많아요. 잠시 후 다시 시도해 주세요.";
    if (error.status === 409) return "메시지 정보를 확인할 수 없어요. 방에 다시 입장해 주세요.";
    if (error.status === 503) return "서버에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.";
  }
  return "연결이 원활하지 않아요. 인터넷 연결을 확인하고 다시 시도해 주세요.";
}
