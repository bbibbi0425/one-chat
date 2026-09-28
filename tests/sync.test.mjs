import test from "node:test";
import assert from "node:assert/strict";
import { drainMessages } from "../lib/sync.ts";
const page = (sequences, more = false) => ({ messages: sequences.map(sequence => ({ sequence, id: String(sequence) })), hasMore: more, serverNow: 0, expiresAt: 1 });

test("drains all pages and keeps intervening incoming and own messages", async () => {
  const cursors = []; const received = [];
  const final = await drainMessages(10, async cursor => {
    cursors.push(cursor);
    return cursor === 10 ? page([11, 12], true) : page([13]);
  }, async p => received.push(...p.messages.map(m => m.sequence)), () => true);
  assert.equal(final, 13); assert.deepEqual(cursors, [10, 12]); assert.deepEqual(received, [11, 12, 13]);
});

test("response arriving after room leave is discarded", async () => {
  let active = true; let applied = false;
  const final = await drainMessages(4, async () => { active = false; return page([5]); }, async () => { applied = true; }, () => active);
  assert.equal(final, 4); assert.equal(applied, false);
});

test("failed processing does not advance cursor, invalid order rejected", async () => {
  await assert.rejects(drainMessages(4, async () => page([5]), async () => { throw new Error("offline"); }, () => true));
  await assert.rejects(drainMessages(4, async () => page([6, 5]), async () => {}, () => true), /INVALID_SEQUENCE/);
});
