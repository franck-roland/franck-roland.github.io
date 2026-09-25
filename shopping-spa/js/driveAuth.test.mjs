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
