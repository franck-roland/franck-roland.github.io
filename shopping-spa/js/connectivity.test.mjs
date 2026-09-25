import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectivity, isNetworkError, OfflineError } from "./connectivity.js";

/** A connectivity instance with a clock and timers we control. */
function harness({ onLine = true } = {}){
  const nav = { onLine };
  let now = 1_000_000;
  const timers = [];
  const listeners = new Map();

  const c = createConnectivity({
    nav,
    clock: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length - 1; },
    clearTimer: (id) => { if(timers[id]) timers[id] = null; },
    addListener: (type, fn) => listeners.set(type, fn)
  });

  return {
    c, nav,
    advance(ms){
      now += ms;
      for(const t of timers){ if(t && t.at <= now){ const fn = t.fn; t.fn = null; fn?.(); } }
    },
    fire(type){ listeners.get(type)?.(); }
  };
}

test("online by default", () => {
  const { c } = harness();
  assert.equal(c.isOffline(), false);
});

test("navigator.onLine false means offline", () => {
  const { c } = harness({ onLine: false });
  assert.equal(c.isOffline(), true);
});

test("a network failure opens a 15s backoff", () => {
  const { c, advance } = harness();
  c.noteFailure(new TypeError("Failed to fetch"));
  assert.equal(c.isOffline(), true);
  advance(14_999);
  assert.equal(c.isOffline(), true, "still inside the backoff");
  advance(2);
  assert.equal(c.isOffline(), false, "backoff expired");
});

test("consecutive failures extend the backoff 15 -> 30 -> 60 and cap", () => {
  const { c, advance } = harness();
  c.noteFailure(new TypeError("x"));
  advance(15_001);

  c.noteFailure(new TypeError("x"));
  advance(15_001);
  assert.equal(c.isOffline(), true, "second failure should last 30s");
  advance(15_001);
  assert.equal(c.isOffline(), false);

  c.noteFailure(new TypeError("x"));
  advance(30_001);
  assert.equal(c.isOffline(), true, "third failure should last 60s");
  advance(30_001);
  assert.equal(c.isOffline(), false);

  c.noteFailure(new TypeError("x"));
  advance(60_001);
  assert.equal(c.isOffline(), false, "the ladder caps at 60s");
});

test("a success clears the backoff and resets the ladder", () => {
  const { c, advance } = harness();
  c.noteFailure(new TypeError("x"));
  c.noteFailure(new TypeError("x"));
  c.noteSuccess();
  assert.equal(c.isOffline(), false, "cleared immediately");

  c.noteFailure(new TypeError("x"));
  advance(15_001);
  assert.equal(c.isOffline(), false, "ladder restarted at 15s");
});

test("an HTTP-level error is not evidence of being offline", () => {
  const { c } = harness();
  c.noteFailure(new Error("Drive listFiles failed: 403"));
  assert.equal(c.isOffline(), false);
});

test("isNetworkError classifies by cause, not by message", () => {
  assert.equal(isNetworkError(new TypeError("Failed to fetch")), true);
  assert.equal(isNetworkError(Object.assign(new Error("t"), { name: "AbortError" })), true);
  assert.equal(isNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" })), true);
  assert.equal(isNetworkError(new OfflineError()), true);
  assert.equal(isNetworkError(new Error("Drive getFileContent failed: 404")), false);
  assert.equal(isNetworkError(null), false);
});

test("subscribers fire on transition only", () => {
  const { c, advance } = harness();
  const seen = [];
  c.subscribe(v => seen.push(v));

  c.noteFailure(new TypeError("x"));
  c.noteFailure(new TypeError("x"));
  assert.deepEqual(seen, [true], "two failures, one transition");

  advance(60_001);
  assert.deepEqual(seen, [true, false], "recovery is announced");
});

test("unsubscribe stops delivery", () => {
  const { c } = harness();
  const seen = [];
  const off = c.subscribe(v => seen.push(v));
  off();
  c.noteFailure(new TypeError("x"));
  assert.deepEqual(seen, []);
});

test("the online event clears a backoff immediately", () => {
  const { c, fire } = harness();
  c.noteFailure(new TypeError("x"));
  assert.equal(c.isOffline(), true);
  fire("online");
  assert.equal(c.isOffline(), false);
});

test("the offline event is announced to subscribers", () => {
  const { c, nav, fire } = harness();
  const seen = [];
  c.subscribe(v => seen.push(v));
  nav.onLine = false;
  fire("offline");
  assert.deepEqual(seen, [true]);
});
