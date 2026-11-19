import test from "node:test";
import assert from "node:assert/strict";

import {
  collectLeaves,
  replaceLeaf,
  removeLeaf,
  setRatio,
  leafAfterClose,
  dockRowHeight,
} from "../.test-dist/src/terminalLayout.js";

const leaf = (termId) => ({ kind: "leaf", termId });
const split = (a, b, orientation = "h", ratio = 0.5) => ({
  kind: "split",
  orientation,
  ratio,
  a,
  b,
});

const ids = (p) => collectLeaves(p).map((l) => l.termId);

test("collects leaves in reading order", () => {
  assert.deepEqual(ids(split(leaf("a"), split(leaf("b"), leaf("c"), "v"))), ["a", "b", "c"]);
});

test("replaces a leaf with a split", () => {
  const next = replaceLeaf(leaf("a"), "a", split(leaf("a"), leaf("b")));
  assert.deepEqual(ids(next), ["a", "b"]);
});

test("removing a leaf collapses its split", () => {
  const tree = split(leaf("a"), split(leaf("b"), leaf("c"), "v"));
  assert.deepEqual(removeLeaf(tree, "b"), split(leaf("a"), leaf("c")));
  assert.equal(removeLeaf(leaf("a"), "a"), null);
});

test("sets the ratio of a nested split", () => {
  const tree = split(leaf("a"), split(leaf("b"), leaf("c"), "v"));
  const next = setRatio(tree, [1], 0.3);
  assert.equal(next.b.ratio, 0.3);
  assert.equal(next.ratio, 0.5);
});

test("focus moves to the neighbouring pane after a close", () => {
  const tree = split(leaf("a"), split(leaf("b"), leaf("c"), "v"));
  assert.equal(leafAfterClose(tree, "c"), "b");
  assert.equal(leafAfterClose(tree, "b"), "a");
  assert.equal(leafAfterClose(tree, "a"), "b");
  assert.equal(leafAfterClose(leaf("a"), "a"), null);
});

test("a collapsed dock is only the tab bar, even when maximized", () => {
  assert.equal(dockRowHeight({ expanded: false, maximized: true, height: 300 }), "34px");
  assert.equal(dockRowHeight({ expanded: false, maximized: false, height: 300 }), "34px");
});

test("an expanded dock uses its height, or the window when maximized", () => {
  assert.equal(dockRowHeight({ expanded: true, maximized: false, height: 300 }), "300px");
  assert.match(dockRowHeight({ expanded: true, maximized: true, height: 300 }), /100vh/);
});
