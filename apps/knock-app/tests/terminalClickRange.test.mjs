import test from "node:test";
import assert from "node:assert/strict";

import {
  collectEditableSegments,
  getSegmentOffset,
  shouldMoveCursorForClick,
  CLICK_OUTPUT_QUIET_MS,
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
