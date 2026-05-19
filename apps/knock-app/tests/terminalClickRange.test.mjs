import test from "node:test";
import assert from "node:assert/strict";

import {
  collectEditableSegments,
  getSegmentOffset,
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
