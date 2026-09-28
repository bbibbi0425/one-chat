import type { ChatMessage } from "./protocol.ts";

export const MAX_RETAINED_MESSAGES = 50;
export type Delivery = "pending" | "delivered" | "unconfirmed";
export interface DisplayMessage extends ChatMessage {
  key: string;
  delivery: Delivery;
  timeLabel: string;
  isoTime: string;
}
export interface TranscriptState {
  messages: readonly DisplayMessage[];
  trimmedCount: number;
  sentRevision: number;
}
export type TranscriptAction =
  | { type: "append"; message: ChatMessage }
  | { type: "delivered" | "unconfirmed"; id: string }
  | { type: "clear" };
export const EMPTY_TRANSCRIPT: TranscriptState = { messages: [], trimmedCount: 0, sentRevision: 0 };
const timeFormatter = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

// Only this bounded snapshot owns message text; there is no hidden history or archive.
export function transcriptReducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === "clear") return EMPTY_TRANSCRIPT;
  if (action.type === "append") {
    const key = `${action.message.mine ? "self" : "peer"}:${action.message.id}`;
    if (state.messages.some(message => message.key === key)) return state;
    const message: DisplayMessage = {
      ...action.message, key,
      delivery: action.message.delivered ? "delivered" : "pending",
      timeLabel: timeFormatter.format(action.message.time),
      isoTime: new Date(action.message.time).toISOString(),
    };
    const removed = Math.max(0, state.messages.length + 1 - MAX_RETAINED_MESSAGES);
    return {
      messages: [...state.messages.slice(removed), message],
      trimmedCount: state.trimmedCount + removed,
      sentRevision: state.sentRevision + (message.mine ? 1 : 0),
    };
  }
  const index = state.messages.findIndex(message => message.mine && message.id === action.id);
  if (index < 0) return state; // Late receipts never recreate evicted text or UI metadata.
  const previous = state.messages[index];
  if (previous.delivery === "delivered" || previous.delivery === action.type) return state;
  const messages = [...state.messages];
  messages[index] = { ...previous, delivery: action.type, delivered: action.type === "delivered" };
  return { ...state, messages };
}
