import test from "node:test";
import assert from "node:assert/strict";

import {
  parseOsc133,
  BlockTracker,
  formatDuration,
  blockBadge,
  textBetween,
} from "../.test-dist/src/terminalBlocks.js";

const lineOf = (m) => m.line;
const at = (line, col = 0) => ({ at: { line }, col });

function run(tracker, marks) {
  for (const [kind, line, col, now, exitCode] of marks) {
    tracker.apply({ kind, exitCode: exitCode ?? null }, at(line, col), now ?? 0);
  }
}

test("parses OSC 133 payloads", () => {
  assert.deepEqual(parseOsc133("A"), { kind: "A", exitCode: null });
  assert.deepEqual(parseOsc133("B"), { kind: "B", exitCode: null });
  assert.deepEqual(parseOsc133("C"), { kind: "C", exitCode: null });
  assert.deepEqual(parseOsc133("D;0"), { kind: "D", exitCode: 0 });
  assert.deepEqual(parseOsc133("D;127"), { kind: "D", exitCode: 127 });
  assert.deepEqual(parseOsc133("D"), { kind: "D", exitCode: null });
  assert.deepEqual(parseOsc133("A;k=i"), { kind: "A", exitCode: null });
  assert.equal(parseOsc133("P;k=v"), null);
  assert.equal(parseOsc133(""), null);
});

test("builds a block per command with its exit code and timing", () => {
  const t = new BlockTracker();
  run(t, [
    ["A", 0], ["B", 0, 2], ["C", 1, 0, 1000], ["D", 3, 0, 1500, 0],
    ["A", 3], ["B", 3, 2], ["C", 4, 0, 2000], ["D", 5, 0, 2100, 2],
    ["A", 5], ["B", 5, 2],
  ]);
  assert.equal(t.blocks.length, 3);
  const [a, b, c] = t.blocks;
  assert.equal(a.state, "done");
  assert.equal(a.exitCode, 0);
  assert.equal(a.finishedAt - a.startedAt, 500);
  assert.equal(b.exitCode, 2);
  assert.equal(c.state, "prompt");
  assert.deepEqual(t.inputAnchor(lineOf), { row: 5, col: 2 });
  assert.equal(t.commandRunning, false);
  assert.deepEqual(
    t.ranges(lineOf, 8).map((r) => [r.start, r.end]),
    [[0, 3], [3, 5], [5, 8]],
  );
  assert.equal(t.blockAtLine(4, lineOf, 8), b);
  assert.equal(t.blockAtLine(9, lineOf, 8), null);
});

test("a redrawn prompt replaces the pending block and releases its handles", () => {
  const released = [];
  const t = new BlockTracker((m) => released.push(m.line));
  run(t, [["A", 0], ["B", 0, 2], ["A", 1], ["B", 1, 4]]);
  assert.equal(t.blocks.length, 1);
  assert.deepEqual(t.inputAnchor(lineOf), { row: 1, col: 4 });
  assert.deepEqual(released.sort(), [0, 0]);
});

test("running commands disable the input anchor", () => {
  const t = new BlockTracker();
  run(t, [["A", 0], ["B", 0, 2], ["C", 1]]);
  assert.equal(t.commandRunning, true);
  assert.equal(t.inputAnchor(lineOf), null);
});

test("an exit without a start mark still finishes the block", () => {
  const t = new BlockTracker();
  run(t, [["A", 0], ["B", 0, 2], ["D", 2, 0, 0, 1]]);
  assert.equal(t.current.state, "done");
  assert.equal(t.current.exitCode, 1);
});

test("stray marks are ignored and released", () => {
  const released = [];
  const t = new BlockTracker((m) => released.push(m.line));
  run(t, [["B", 0, 1], ["C", 0], ["D", 0, 0, 0, 0]]);
  assert.equal(t.blocks.length, 0);
  assert.equal(t.active, false);
  assert.equal(released.length, 3);
});

test("prune drops blocks scrolled out of the buffer", () => {
  const t = new BlockTracker();
  run(t, [["A", 0], ["C", 1], ["D", 2, 0, 0, 0], ["A", 2]]);
  t.blocks[0].prompt.line = -1;
  t.prune(lineOf);
  assert.equal(t.blocks.length, 1);
  t.clear();
  assert.equal(t.blocks.length, 0);
});

test("formats durations compactly", () => {
  assert.equal(formatDuration(840), "840ms");
  assert.equal(formatDuration(3240), "3.2s");
  assert.equal(formatDuration(42000), "42s");
  assert.equal(formatDuration(65000), "1m 05s");
  assert.equal(formatDuration(2 * 3600e3 + 3 * 60e3), "2h 03m");
  assert.equal(formatDuration(-1), "");
});

test("badges show failures and durations", () => {
  assert.deepEqual(blockBadge({ exitCode: 1, startedAt: 0, finishedAt: 1500 }), {
    text: "exit 1 · 1.5s",
    failed: true,
  });
  assert.deepEqual(blockBadge({ exitCode: 0, startedAt: 0, finishedAt: 20 }), {
    text: "20ms",
    failed: false,
  });
  assert.equal(blockBadge({ exitCode: 0, startedAt: null, finishedAt: null }), null);
});

test("extracts text joining soft wraps and trimming padding", () => {
  const rows = [
    { text: "% echo hello wor", isWrapped: false },
    { text: "ld              ", isWrapped: true },
    { text: "hello world     ", isWrapped: false },
    { text: "% ", isWrapped: false },
  ];
  const get = (r, a, b) => (rows[r] ? { ...rows[r], text: rows[r].text.slice(a, b) } : null);
  assert.equal(textBetween(get, { row: 0, col: 2 }, { row: 2, col: 0 }), "echo hello world");
  assert.equal(textBetween(get, { row: 2, col: 0 }, { row: 3, col: 0 }), "hello world");
});
