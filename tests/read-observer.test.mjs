import test from "node:test";
import assert from "node:assert/strict";
import { observeReadMessages } from "../lib/read-observer.ts";

class Target {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  get count() { return [...this.listeners.values()].reduce((sum, value) => sum + value.size, 0); }
}
function fixture() {
  const win = new Target(), doc = new Target(), box = new Target();
  const frames = new Map(), calls = [];
  let frameId = 0;
  const state = { focused: true, enabled: true, covered: false, inert: false, rows: [] };
  Object.assign(win, { innerWidth: 400, innerHeight: 300,
    requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
  });
  Object.assign(doc, { defaultView: win, visibilityState: "visible", hasFocus: () => state.focused,
    elementFromPoint: (x, y) => state.covered ? box : state.rows.find(row => x >= row.rect.left && x <= row.rect.right && y >= row.rect.top && y <= row.rect.bottom) ?? box,
  });
  Object.assign(box, { ownerDocument: doc, isConnected: true, closest: () => state.inert ? box : null,
    getBoundingClientRect: () => ({ top: 20, bottom: 220, left: 10, right: 310 }),
    querySelectorAll: () => state.rows,
  });
  const row = (id, top, height = 40) => {
    const value = { dataset: { readId: id }, rect: { top, bottom: top + height, left: 20, right: 220, width: 200, height } };
    value.getBoundingClientRect = () => value.rect;
    value.contains = hit => hit === value;
    state.rows.push(value); return value;
  };
  const flush = () => {
    const queued = [...frames.values()]; frames.clear();
    queued.forEach(callback => callback());
  };
  const observer = observeReadMessages(box, () => state.enabled, async ids => { calls.push(ids); });
  return { win, doc, box, state, row, calls, frames, flush, observer };
}
test("hidden, unfocused and disconnected views do not report reads; returning reports visible messages", t => {
  const f = fixture(); t.after(() => f.observer.dispose());
  f.row("visible", 40); f.row("outside", 250);
  f.doc.visibilityState = "hidden"; f.flush(); assert.deepEqual(f.calls, []);
  f.doc.visibilityState = "visible"; f.state.focused = false; f.doc.emit("visibilitychange"); f.flush(); assert.deepEqual(f.calls, []);
  f.state.focused = true; f.state.enabled = false; f.win.emit("focus"); f.flush(); assert.deepEqual(f.calls, []);
  f.state.enabled = true; f.box.isConnected = false; f.observer.refresh(); f.flush(); assert.deepEqual(f.calls, []);
  f.box.isConnected = true; f.observer.refresh(); f.flush(); assert.deepEqual(f.calls, [["visible"]]);
});
test("scrolling confirms only newly visible messages and batches repeated events into one frame", t => {
  const f = fixture(); t.after(() => f.observer.dispose());
  f.row("first", 40); const next = f.row("next", 250);
  f.flush(); assert.deepEqual(f.calls, [["first"]]);
  f.win.emit("focus"); f.win.emit("scroll"); f.win.emit("resize"); f.observer.refresh();
  assert.equal(f.frames.size, 1); f.flush(); assert.equal(f.calls.length, 1);
  next.rect.top = 170; next.rect.bottom = 210;
  f.win.emit("scroll"); f.flush(); assert.deepEqual(f.calls, [["first"], ["next"]]);
  assert.equal(f.frames.size, 0);
});
test("dialogs, occlusion and tiny clipped fragments do not count as reading", t => {
  const f = fixture(); t.after(() => f.observer.dispose());
  f.row("visible", 40); f.row("sliver", 215);
  f.state.inert = true; f.flush(); assert.deepEqual(f.calls, []);
  f.state.inert = false; f.state.covered = true; f.doc.emit("focusin"); f.flush(); assert.deepEqual(f.calls, []);
  f.state.covered = false; f.doc.emit("focusin"); f.flush(); assert.deepEqual(f.calls, [["visible"]]);
});
test("viewport clipping also applies when the whole conversation extends below the window", t => {
  const f = fixture(); t.after(() => f.observer.dispose());
  f.box.getBoundingClientRect = () => ({ top: 20, bottom: 800, left: 10, right: 310 });
  f.row("inside", 50); f.row("outside-window", 350);
  f.flush(); assert.deepEqual(f.calls, [["inside"]]);
});
test("eviction before inspection does not read deleted messages and cleanup cancels queued work", () => {
  const f = fixture();
  const old = f.row("removed-before-paint", 40);
  f.state.rows = [];
  f.flush(); assert.deepEqual(f.calls, []);
  f.row("current", 40); f.observer.refresh(); f.flush(); assert.deepEqual(f.calls, [["current"]]);
  assert.equal(f.state.rows.includes(old), false);
  f.row("pending", 100); f.observer.refresh(); assert.equal(f.frames.size, 1);
  f.observer.dispose(); assert.equal(f.frames.size, 0);
  assert.equal(f.win.count + f.doc.count + f.box.count, 0);
  f.observer.refresh(); f.win.emit("focus"); f.flush();
  assert.deepEqual(f.calls, [["current"]]);
});
