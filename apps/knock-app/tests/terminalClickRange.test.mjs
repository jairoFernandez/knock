import test from "node:test";
import assert from "node:assert/strict";

import {
  collectEditableSegments,
  getSegmentOffset,
  shouldMoveCursorForClick,
  shouldResizePty,
  CLICK_OUTPUT_QUIET_MS,
  CLICK_MOVE_DELAY_MS,
} from "../.test-dist/src/terminalClickRange.js";

function makeBuffer({ cols = 20, cursorRow, cursorCol, lines }) {
  return {
    cols,
    cursorRow,
    cursorCol,
    length: lines.length,
    getLine(row) {
      return lines[row] ?? null;
    },
  };
}

test("collects wrapped rows as one editable block", () => {
  const buffer = makeBuffer({
    cols: 10,
    cursorRow: 2,
    cursorCol: 4,
    lines: [
      { text: "$ ", isWrapped: false },
      { text: "abcdefghij", isWrapped: false },
      { text: "klmn      ", isWrapped: true },
    ],
  });

  const segments = collectEditableSegments(buffer);

  assert.deepEqual(segments, [
    { row: 0, promptCols: 1, editableCols: 0 },
    { row: 1, promptCols: 0, editableCols: 10 },
    { row: 2, promptCols: 0, editableCols: 4 },
  ]);
  assert.equal(getSegmentOffset(segments, 2, 3), 13);
});

test("keeps the whole multiline command clickable after moving cursor upward", () => {
  const buffer = makeBuffer({
    cols: 80,
    cursorRow: 2,
    cursorCol: 5,
    lines: [
      { text: "$ ", isWrapped: false },
      { text: "curl -X POST \"https://api.ejemplo.com/v1/usuarios\" \\", isWrapped: false },
      { text: "-H \"Authorization: Bearer TU_TOKEN\" \\", isWrapped: false },
      { text: "-H \"Content-Type: application/json\" \\", isWrapped: false },
      { text: "-d '{", isWrapped: false },
      { text: '  "nombre": "Jairo",', isWrapped: false },
      { text: '  "activo": true', isWrapped: false },
      { text: "}'", isWrapped: false },
    ],
  });

  const segments = collectEditableSegments(buffer);

  assert.deepEqual(
    segments.map((segment) => segment.row),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  const cursorOffset = getSegmentOffset(segments, buffer.cursorRow, buffer.cursorCol);
  const lowerRowOffset = getSegmentOffset(segments, 6, 8);
  assert.notEqual(cursorOffset, null);
  assert.notEqual(lowerRowOffset, null);
  assert.ok(lowerRowOffset > cursorOffset);
});

test("treats continuation prompts as part of the same editable block", () => {
  const buffer = makeBuffer({
    cols: 40,
    cursorRow: 3,
    cursorCol: 6,
    lines: [
      { text: "$ ", isWrapped: false },
      { text: "cat <<'EOF'", isWrapped: false },
      { text: "> alpha", isWrapped: false },
      { text: "> beta", isWrapped: false },
      { text: "EOF", isWrapped: false },
    ],
  });

  const segments = collectEditableSegments(buffer);

  assert.deepEqual(
    segments.map((segment) => ({
      row: segment.row,
      promptCols: segment.promptCols,
      editableCols: segment.editableCols,
    })),
    [
      { row: 0, promptCols: 1, editableCols: 0 },
      { row: 1, promptCols: 0, editableCols: 11 },
      { row: 2, promptCols: 2, editableCols: 5 },
      { row: 3, promptCols: 2, editableCols: 4 },
    ],
  );
});

// -------- click-to-position-cursor guard --------

function makeClickState(overrides = {}) {
  return {
    viewportY: 100,
    baseY: 100,
    lastWriteAt: 0,
    now: 10_000,
    selectionLength: 0,
    dragDistance: 0,
    ...overrides,
  };
}

test("moves the cursor for a quiet click on the live prompt", () => {
  assert.equal(shouldMoveCursorForClick(makeClickState()), true);
});

test("ignores a drag: the user is selecting text", () => {
  assert.equal(
    shouldMoveCursorForClick(makeClickState({ dragDistance: 4 })),
    false,
  );
  // 3px of jitter still counts as a click, not a drag.
  assert.equal(
    shouldMoveCursorForClick(makeClickState({ dragDistance: 3 })),
    true,
  );
});

test("ignores a click while a selection is active", () => {
  assert.equal(
    shouldMoveCursorForClick(makeClickState({ selectionLength: 12 })),
    false,
  );
});

test("ignores a click while scrolled back through history", () => {
  // Clicked row belongs to scrollback, not to the shell's input line.
  assert.equal(
    shouldMoveCursorForClick(makeClickState({ viewportY: 40, baseY: 100 })),
    false,
  );
});

test("ignores a click while output is still streaming", () => {
  // The row under the pointer has already scrolled away by now.
  assert.equal(
    shouldMoveCursorForClick(
      makeClickState({ now: 10_000, lastWriteAt: 9_950 }),
    ),
    false,
  );
});

test("resumes moving the cursor once output goes quiet", () => {
  const quietAt = 10_000 - CLICK_OUTPUT_QUIET_MS;
  assert.equal(
    shouldMoveCursorForClick(makeClickState({ now: 10_000, lastWriteAt: quietAt })),
    true,
  );
  assert.equal(
    shouldMoveCursorForClick(
      makeClickState({ now: 10_000, lastWriteAt: quietAt + 1 }),
    ),
    false,
  );
});

test("ignores the clicks of a double or triple click", () => {
  // Moving the cursor on the first click of a word selection makes the shell
  // redraw the line under the word the user is about to select.
  assert.equal(shouldMoveCursorForClick(makeClickState({ clickCount: 2 })), false);
  assert.equal(shouldMoveCursorForClick(makeClickState({ clickCount: 3 })), false);
  assert.equal(shouldMoveCursorForClick(makeClickState({ clickCount: 1 })), true);
});

test("ignores modified clicks (link open, selection extend)", () => {
  assert.equal(shouldMoveCursorForClick(makeClickState({ modifier: true })), false);
});

test("ignores clicks while a full-screen program owns the screen", () => {
  assert.equal(
    shouldMoveCursorForClick(makeClickState({ alternateBuffer: true })),
    false,
  );
});

test("ignores clicks when the program tracks the mouse itself", () => {
  assert.equal(
    shouldMoveCursorForClick(makeClickState({ mouseTracking: true })),
    false,
  );
});

test("defers click-to-move long enough to see a double click", () => {
  assert.ok(CLICK_MOVE_DELAY_MS >= 120 && CLICK_MOVE_DELAY_MS <= 300);
});

// -------- PTY resize gate --------

function makeResizeState(overrides = {}) {
  return { cols: 120, rows: 30, ptyCols: 100, ptyRows: 24, ...overrides };
}

test("forwards a genuine geometry change to the PTY", () => {
  assert.equal(shouldResizePty(makeResizeState()), true);
});

test("suppresses a resize that matches what the PTY already has", () => {
  // The repeated no-op case: fit() runs on every ResizeObserver notification
  // but usually measures the same grid. Forwarding it raises a pointless
  // SIGWINCH and makes full-screen programs repaint.
  assert.equal(
    shouldResizePty(makeResizeState({ cols: 100, rows: 24 })),
    false,
  );
});

test("forwards when only one dimension changed", () => {
  assert.equal(
    shouldResizePty(makeResizeState({ cols: 100, rows: 40 })),
    true,
  );
  assert.equal(
    shouldResizePty(makeResizeState({ cols: 140, rows: 24 })),
    true,
  );
});

test("suppresses a resize before the container is laid out", () => {
  // A hidden or not-yet-measured container reports 0; resizing the PTY to that
  // wedges the child process at a bogus size.
  assert.equal(shouldResizePty(makeResizeState({ cols: 0, rows: 0 })), false);
  assert.equal(shouldResizePty(makeResizeState({ cols: 0 })), false);
  assert.equal(shouldResizePty(makeResizeState({ rows: 0 })), false);
});

test("suppresses a non-finite measurement", () => {
  assert.equal(shouldResizePty(makeResizeState({ cols: NaN })), false);
  assert.equal(shouldResizePty(makeResizeState({ rows: Infinity })), false);
});

import {
  arrowPressesBetween,
  columnAtPixel,
  findGhostStart,
} from "../.test-dist/src/terminalClickRange.js";

test("an integration anchor replaces prompt guessing", () => {
  // A prompt the regexes cannot recognise: "~/knock main ✗ ".
  const buffer = makeBuffer({
    cols: 40,
    cursorRow: 0,
    cursorCol: 22,
    lines: [{ text: "~/knock main x git st", isWrapped: false }],
  });
  const segments = collectEditableSegments(buffer, { row: 0, col: 15 });
  assert.deepEqual(segments, [{ row: 0, promptCols: 15, editableCols: 7 }]);
  // Clicking inside the prompt clamps to the input start.
  assert.equal(getSegmentOffset(segments, 0, 3), 0);
});

test("an anchor spans a multi-line prompt down to the cursor", () => {
  const buffer = makeBuffer({
    cols: 10,
    cursorRow: 2,
    cursorCol: 3,
    lines: [
      { text: "$ abcdefgh", isWrapped: false },
      { text: "ijklmnopqr", isWrapped: true },
      { text: "stu       ", isWrapped: true },
    ],
  });
  const segments = collectEditableSegments(buffer, { row: 0, col: 2 });
  assert.deepEqual(segments.map((s) => s.editableCols), [8, 10, 3]);
});

test("trailing typed spaces count as input", () => {
  const buffer = makeBuffer({
    cols: 20,
    cursorRow: 0,
    cursorCol: 5,
    lines: [{ text: "$ ls ", isWrapped: false }],
  });
  const segments = collectEditableSegments(buffer, { row: 0, col: 2 });
  assert.equal(getSegmentOffset(segments, 0, 5), 3);
  assert.equal(getSegmentOffset(segments, 0, 2), 0);
});

test("autosuggestion text is not clickable", () => {
  const buffer = makeBuffer({
    cols: 30,
    cursorRow: 0,
    cursorCol: 4,
    lines: [{ text: "$ gitstatus --short", isWrapped: false, ghostFrom: 5 }],
  });
  const segments = collectEditableSegments(buffer, { row: 0, col: 2 });
  assert.deepEqual(segments, [{ row: 0, promptCols: 2, editableCols: 3 }]);
});

test("wide characters take one arrow press", () => {
  // "$ a日b": 日 spans columns 3-4.
  const buffer = makeBuffer({
    cols: 20,
    cursorRow: 0,
    cursorCol: 6,
    lines: [{ text: "$ a日_b", isWrapped: false, widths: [1, 1, 1, 2, 0, 1] }],
  });
  const segments = collectEditableSegments(buffer, { row: 0, col: 2 });
  const cursor = getSegmentOffset(segments, 0, 6);
  assert.equal(arrowPressesBetween(buffer, segments, cursor, getSegmentOffset(segments, 0, 2)), 3);
  assert.equal(arrowPressesBetween(buffer, segments, cursor, getSegmentOffset(segments, 0, 5)), 1);
  assert.equal(arrowPressesBetween(buffer, segments, 0, 1), 1);
});

test("arrow presses fall back to one per cell without widths", () => {
  const buffer = makeBuffer({
    cols: 20,
    cursorRow: 0,
    cursorCol: 6,
    lines: [{ text: "$ abcd", isWrapped: false }],
  });
  const segments = collectEditableSegments(buffer, { row: 0, col: 2 });
  assert.equal(arrowPressesBetween(buffer, segments, 4, 1), 3);
});

test("clicks snap to the nearest gap between cells", () => {
  assert.equal(columnAtPixel(10 + 8 * 3 + 3, 10, 8, 80), 3);
  assert.equal(columnAtPixel(10 + 8 * 3 + 5, 10, 8, 80), 4);
  assert.equal(columnAtPixel(0, 10, 8, 80), 0);
  assert.equal(columnAtPixel(10000, 10, 8, 80), 80);
  assert.equal(columnAtPixel(50, 10, 0, 80), 0);
});

test("finds the start of faint suggestion text after the cursor", () => {
  const typed = { filled: true, fg: "default", faint: false };
  const ghost = { filled: true, fg: "p8", faint: true };
  const blank = { filled: false, fg: "default", faint: false };
  assert.equal(findGhostStart([typed, typed, ghost, ghost, blank], 2), 2);
  assert.equal(findGhostStart([typed, typed, blank], 2), null);
  // Faint text followed by normal text is regular highlighting.
  assert.equal(findGhostStart([typed, ghost, typed], 1), null);
  assert.equal(findGhostStart([typed, ghost, { ...ghost, fg: "p7" }], 1), null);
});
