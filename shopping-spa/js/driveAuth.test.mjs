import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenDecision } from "./driveAuth.js";

const NOW = 1_000_000;

test("a comfortably valid token is used", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 600_000 }, NOW), "use");
});

test("a missing token yields none rather than a prompt", () => {
  assert.equal(tokenDecision(null, NOW), "none");
});

test("an expired token yields none", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW - 1 }, NOW), "none");
});

test("a token inside the clock-skew margin is treated as expired", () => {
  // 10s of life left, and the margin is 30s: too close to start a request with.
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 10_000 }, NOW), "none");
});

test("the skew margin is configurable", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 10_000 }, NOW, 5_000), "use");
});

// DriveAuth.isSignedIn() is now this decision and nothing else, so the cases
// below are the gate's third state, the top bar's Sign in button and
// syncActive's catch branch all at once. Before the fix isSignedIn() only
// asked whether a token was *present*, so every case here read as signed in.
test("a long-expired token is not signed in", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW - 3_600_000 }, NOW), "none");
});

test("a token expiring exactly at the skew boundary is not used", () => {
  // The comparison is strictly greater-than, so equality falls on the safe
  // side: exactly the margin left is not worth starting a request with.
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 30_000 }, NOW), "none");
});

test("one millisecond past the skew boundary is used", () => {
  assert.equal(tokenDecision({ access_token: "t", expires_at: NOW + 30_001 }, NOW), "use");
});

test("a token with no expiry at all is not used", () => {
  assert.equal(tokenDecision({ access_token: "t" }, NOW), "none");
});
