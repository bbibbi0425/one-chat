import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TRANSCRIPT, MAX_RETAINED_MESSAGES, transcriptReducer } from "../lib/transcript.ts";
function message(index, mine = index % 2 === 0) {
  return { id: crypto.randomUUID(), nickname: mine ? "나" : "상대", text: `message-${index}`, time: 1800000000000 + index, mine, delivered: !mine };
}
function append(state, value) { return transcriptReducer(state, { type: "append", message: value }); }

test("a long conversation retains only the latest 50 incoming and outgoing messages", () => {
  let state = EMPTY_TRANSCRIPT;
  for (let index = 0; index < 1000; index++) {
    state = append(state, message(index));
    assert.ok(state.messages.length <= MAX_RETAINED_MESSAGES);
  }
  assert.equal(state.messages.length, 50);
  assert.deepEqual(state.messages.map(m => m.text), Array.from({ length: 50 }, (_, i) => `message-${950 + i}`));
  assert.equal(state.trimmedCount, 950);
  assert.equal(JSON.stringify(state).includes('"message-0"'), false);
});
test("late delivery events cannot restore an evicted message or allocate orphan receipt state", () => {
  const old = message(0, true); let state = append(EMPTY_TRANSCRIPT, old);
  for (let i = 1; i <= 50; i++) state = append(state, message(i));
  assert.equal(state.messages.some(m => m.id === old.id), false);
  assert.equal(transcriptReducer(state, { type: "unconfirmed", id: old.id }), state);
  assert.equal(transcriptReducer(state, { type: "delivered", id: old.id }), state);
  assert.equal(state.messages.length, 50);
});
test("delivery changes preserve all unaffected row identities and preformatted times", () => {
  const first = message(0, true), second = message(1, true);
  const initial = append(append(EMPTY_TRANSCRIPT, first), second);
  const unconfirmed = transcriptReducer(initial, { type: "unconfirmed", id: second.id });
  assert.equal(unconfirmed.messages[0], initial.messages[0]);
  assert.equal(unconfirmed.messages[1].delivery, "unconfirmed");
  const delivered = transcriptReducer(unconfirmed, { type: "delivered", id: second.id });
  assert.equal(delivered.messages[0], initial.messages[0]);
  assert.equal(delivered.messages[1].timeLabel, initial.messages[1].timeLabel);
  assert.equal(delivered.messages[1].isoTime, initial.messages[1].isoTime);
  assert.equal(delivered.messages[1].delivery, "delivered");
  assert.equal(transcriptReducer(delivered, { type: "unconfirmed", id: second.id }), delivered);
  assert.equal(transcriptReducer(delivered, { type: "delivered", id: second.id }), delivered);
});
test("clearing a room drops the transcript and old receipts cannot populate a new room", () => {
  const old = message(0, true); const populated = append(EMPTY_TRANSCRIPT, old);
  const cleared = transcriptReducer(populated, { type: "clear" });
  assert.equal(cleared, EMPTY_TRANSCRIPT); assert.equal(cleared.messages.length, 0);
  const fresh = append(cleared, message(1));
  assert.equal(transcriptReducer(fresh, { type: "delivered", id: old.id }), fresh);
  assert.equal(fresh.trimmedCount, 0);
});

test("batched read receipts affect only retained outgoing messages and never regress", () => {
  const first = message(0, true), second = message(1, true), incoming = message(2, false);
  const before = append(append(append(EMPTY_TRANSCRIPT, first), second), incoming);
  const read = transcriptReducer(before, { type: "read", ids: [second.id, incoming.id, crypto.randomUUID()] });
  assert.equal(read.messages[0], before.messages[0]);
  assert.equal(read.messages[2], before.messages[2]);
  assert.equal(read.messages[1].delivery, "read"); assert.equal(read.messages[1].delivered, true);
  assert.equal(read.messages[1].timeLabel, before.messages[1].timeLabel);
  for (const type of ["delivered", "unconfirmed"]) assert.equal(transcriptReducer(read, { type, id: second.id }), read);
  assert.equal(transcriptReducer(read, { type: "read", ids: [second.id] }), read);
  let trimmed = read;
  for (let i = 0; i < MAX_RETAINED_MESSAGES; i++) trimmed = append(trimmed, message(i));
  assert.equal(transcriptReducer(trimmed, { type: "read", ids: [first.id, second.id] }), trimmed);
  assert.equal(transcriptReducer(EMPTY_TRANSCRIPT, { type: "read", ids: [second.id] }), EMPTY_TRANSCRIPT);
});
