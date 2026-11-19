import test from "node:test";
import assert from "node:assert/strict";

import { isCacheUsable, stargazerNotice } from "../.test-dist/src/stargazers.js";

test("a cache that no longer matches the star count is not reused", () => {
  assert.equal(isCacheUsable(2, 4), false);
  assert.equal(isCacheUsable(4, 4), true);
});

test("a cache is reusable when the live count is unknown", () => {
  assert.equal(isCacheUsable(2, null), true);
  assert.equal(isCacheUsable(0, null), false);
});

test("no notice when the list is complete and fresh", () => {
  assert.equal(stargazerNotice({ listed: 4, total: 4, stale: false }), null);
  assert.equal(stargazerNotice({ listed: 4, total: null, stale: false }), null);
});

test("a stale fallback says so and explains why", () => {
  const n = stargazerNotice({ listed: 2, total: 4, stale: true });
  assert.match(n, /Showing 2 of 4/);
  assert.match(n, /sign-in/);
});

test("a partial fresh list shows the real total", () => {
  assert.equal(stargazerNotice({ listed: 2, total: 4, stale: false }), "Showing 2 of 4.");
});
