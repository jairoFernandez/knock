const CONTINUATION_PROMPT_RE =
  /^\s*(?:>|quote>|dquote>|bquote>|cmdsubst>|heredoc>|pipe>|continuation>)\s?/i;
const PROMPT_ONLY_RE = /^\s*[$#>%❯➜→λ]+\s*$/u;
const MULTILINE_CONTINUATION_RE = /^\s*(?:[-"'`~)}\]>{|&]|[([{,])/;

export interface TerminalClickLine {
  /** One character per cell, so string indexes are columns. */
  text: string;
  isWrapped: boolean;
  /** Cell widths: 0 for the trailing half of a wide character. */
  widths?: number[];
  /** First column of autosuggestion (ghost) text, which is not input yet. */
  ghostFrom?: number;
}

export interface TerminalClickBuffer {
  cols: number;
  cursorRow: number;
  cursorCol: number;
  length: number;
  getLine(row: number): TerminalClickLine | null;
}

export interface EditableRowSegment {
  row: number;
  promptCols: number;
  editableCols: number;
}

function getLine(buffer: TerminalClickBuffer, row: number): TerminalClickLine | null {
  if (row < 0 || row >= buffer.length) return null;
  return buffer.getLine(row);
}

function getLineText(buffer: TerminalClickBuffer, row: number): string {
  return getLine(buffer, row)?.text ?? "";
}

function getPromptCols(lineText: string): number {
  const match = lineText.match(CONTINUATION_PROMPT_RE);
  return match ? match[0].length : 0;
}

function getLineTextEnd(lineText: string): number {
  return lineText.trimEnd().length;
}

function isPromptOnlyRowText(lineText: string): boolean {
  return PROMPT_ONLY_RE.test(lineText.trim());
}

function isMultilineContinuationText(lineText: string): boolean {
  return MULTILINE_CONTINUATION_RE.test(lineText);
}

function getEditableRowSegment(
  buffer: TerminalClickBuffer,
  row: number,
  anchorCol?: number,
): EditableRowSegment | null {
  const line = getLine(buffer, row);
  if (!line) return null;
  const lineText = getLineText(buffer, row);
  if (anchorCol === undefined && isPromptOnlyRowText(lineText)) {
    return { row, promptCols: getLineTextEnd(lineText), editableCols: 0 };
  }
  const promptCols =
    anchorCol !== undefined ? anchorCol : line.isWrapped ? 0 : getPromptCols(lineText);
  const nextLine = getLine(buffer, row + 1);
  let end = nextLine?.isWrapped ? buffer.cols : lineText.trimEnd().length;
  // Trailing spaces the user typed are input too, even though they look blank.
  if (row === buffer.cursorRow) end = Math.max(end, buffer.cursorCol);
  if (line.ghostFrom !== undefined) end = Math.min(end, line.ghostFrom);
  return { row, promptCols, editableCols: Math.max(0, end - promptCols) };
}

function isContinuationRow(buffer: TerminalClickBuffer, row: number): boolean {
  const line = getLine(buffer, row);
  if (!line || line.isWrapped) return false;
  return CONTINUATION_PROMPT_RE.test(getLineText(buffer, row));
}

function shouldAttachToPreviousRow(buffer: TerminalClickBuffer, row: number): boolean {
  if (row <= 0) return false;
  const line = getLine(buffer, row);
  if (!line) return false;
  const lineText = getLineText(buffer, row).trimEnd();
  const prevText = getLineText(buffer, row - 1).trimEnd();
  return (
    line.isWrapped ||
    isContinuationRow(buffer, row) ||
    isMultilineContinuationText(lineText) ||
    isPromptOnlyRowText(prevText)
  );
}

/**
 * Rows of the command line being edited.
 *
 * With shell integration `anchor` is the exact input start (OSC 133;B), so the
 * prompt is never guessed from its text. Without it the prompt and the start
 * of a multi-line command are inferred from the cursor row.
 */
export function collectEditableSegments(
  buffer: TerminalClickBuffer,
  anchor?: { row: number; col: number },
): EditableRowSegment[] {
  let startRow = buffer.cursorRow;
  if (anchor) {
    startRow = anchor.row;
  } else {
    while (startRow > 0 && shouldAttachToPreviousRow(buffer, startRow)) {
      startRow -= 1;
    }
  }
  const segments: EditableRowSegment[] = [];
  let row = startRow;
  while (row < buffer.length) {
    const segment = getEditableRowSegment(
      buffer,
      row,
      anchor && row === anchor.row ? anchor.col : undefined,
    );
    if (!segment) break;
    segments.push(segment);
    // Everything after autosuggestion text is suggestion too.
    if (getLine(buffer, row)?.ghostFrom !== undefined) break;
    const nextRow = row + 1;
    if (nextRow >= buffer.length) break;
    if (
      (anchor && nextRow <= buffer.cursorRow) ||
      (!(anchor && row === anchor.row) && isPromptOnlyRowText(getLineText(buffer, row).trimEnd())) ||
      shouldAttachToPreviousRow(buffer, nextRow)
    ) {
      row += 1;
      continue;
    }
    break;
  }
  return segments;
}

export function getSegmentOffset(
  segments: EditableRowSegment[],
  row: number,
  col: number,
): number | null {
  let offset = 0;
  for (const segment of segments) {
    if (segment.row === row) {
      const innerCol = Math.max(0, Math.min(col - segment.promptCols, segment.editableCols));
      return offset + innerCol;
    }
    offset += segment.editableCols;
  }
  return null;
}

/**
 * Number of arrow-key presses that move the cursor between two offsets.
 *
 * Offsets count cells, but the shell moves by characters: a wide character
 * (CJK, emoji) spans two cells and takes a single press.
 */
export function arrowPressesBetween(
  buffer: TerminalClickBuffer,
  segments: EditableRowSegment[],
  fromOffset: number,
  toOffset: number,
): number {
  const lo = Math.min(fromOffset, toOffset);
  const hi = Math.max(fromOffset, toOffset);
  let offset = 0;
  let presses = 0;
  for (const seg of segments) {
    const widths = getLine(buffer, seg.row)?.widths;
    for (let i = 0; i < seg.editableCols; i++, offset++) {
      if (offset < lo) continue;
      if (offset >= hi) return presses;
      const w = widths ? widths[seg.promptCols + i] : 1;
      if (w === undefined || w > 0) presses++;
    }
  }
  // Positions past the known cells (cursor beyond trailing spaces).
  return presses + Math.max(0, hi - Math.max(lo, offset));
}

/**
 * Column for a pointer x coordinate: the gap between cells nearest to the
 * pointer, the way text editors place a caret. Clicking the right half of a
 * character puts the cursor after it.
 */
export function columnAtPixel(x: number, left: number, cellWidth: number, cols: number): number {
  if (!(cellWidth > 0)) return 0;
  const col = Math.round((x - left) / cellWidth);
  return Math.max(0, Math.min(cols, col));
}

export interface GhostCell {
  /** The cell holds a character (not blank). */
  filled: boolean;
  /** Foreground identity, e.g. "p8" or "rgb:666666"; equal for the same style. */
  fg: string;
  /** Dim/faint attribute, or a grey foreground typical of suggestions. */
  faint: boolean;
}

/**
 * Where autosuggestion text starts on the cursor row, if any.
 *
 * zsh-autosuggestions and fish draw the suggested rest of the command after
 * the cursor in a faint color. It is not part of the input: a click there
 * would send → presses that accept the suggestion instead of moving.
 */
export function findGhostStart(cells: GhostCell[], cursorCol: number): number | null {
  const first = cells[cursorCol];
  if (!first || !first.filled || !first.faint) return null;
  for (let c = cursorCol; c < cells.length; c++) {
    const cell = cells[c];
    if (cell.filled && (!cell.faint || cell.fg !== first.fg)) return null;
  }
  return cursorCol;
}

/**
 * Time after the last PTY write during which click-to-position-cursor is
 * suppressed. While a process is streaming output the row a click landed on is
 * already stale by the time the handler runs, so the arrow keys we would send
 * move the cursor somewhere the user never pointed at — and in a shell that is
 * echoing, they corrupt the current input line.
 */
export const CLICK_OUTPUT_QUIET_MS = 150;

export interface ClickCursorMoveState {
  /** Buffer row currently at the top of the viewport. */
  viewportY: number;
  /** Buffer row at the top of the viewport when scrolled fully to the bottom. */
  baseY: number;
  /** Timestamp of the last write into the emulator, in ms. */
  lastWriteAt: number;
  /** Current time, in ms. */
  now: number;
  /** Length of the emulator's current selection. */
  selectionLength: number;
  /** Pixel distance the pointer travelled between mousedown and mouseup. */
  dragDistance: number;
  /** MouseEvent.detail: 2+ is a double/triple click selecting a word/line. */
  clickCount?: number;
  /** A modifier was held (Cmd/Ctrl-click opens links, Alt/Shift extend selection). */
  modifier?: boolean;
  /** A full-screen program (vim, less, htop) owns the alternate buffer. */
  alternateBuffer?: boolean;
  /** The program asked for mouse events; it handles clicks itself. */
  mouseTracking?: boolean;
}

/**
 * Delay before a click is turned into cursor movement. A double or triple
 * click starts with a plain click; acting on it at once sends arrow keys that
 * make the shell redraw the line under the word the user is about to select,
 * so the selection lands on shifted text. The next mousedown cancels it.
 */
export const CLICK_MOVE_DELAY_MS = 180;

/**
 * Whether a click should be translated into cursor-movement keys.
 *
 * Every rejection here is a case where sending arrow keys does damage rather
 * than nothing: scrolled-back views address rows the shell no longer owns,
 * live output races the coordinates, a drag is a selection gesture, and an
 * existing selection means the user is copying, not repositioning.
 */
export function shouldMoveCursorForClick(state: ClickCursorMoveState): boolean {
  // A drag is a text selection, not a click.
  if (state.dragDistance > 3) return false;
  if ((state.clickCount ?? 1) > 1) return false;
  if (state.modifier) return false;
  // Arrow keys mean something else to vim/less, and mouse-aware programs
  // already receive the click themselves.
  if (state.alternateBuffer || state.mouseTracking) return false;
  // The user is selecting text to copy; never disturb the input line.
  if (state.selectionLength > 0) return false;
  // Scrolled back through history: the clicked row is not the input line.
  if (state.viewportY !== state.baseY) return false;
  // Output is still streaming; the clicked coordinates are already stale.
  if (state.now - state.lastWriteAt < CLICK_OUTPUT_QUIET_MS) return false;
  return true;
}

export interface PtyResizeState {
  /** Geometry xterm reports after fit(). */
  cols: number;
  rows: number;
  /** Geometry the PTY was last told about. */
  ptyCols: number;
  ptyRows: number;
}

/**
 * Whether a fit() result is worth forwarding to the PTY.
 *
 * Every resize that reaches the PTY raises SIGWINCH, and a full-screen program
 * redraws on each one. A ResizeObserver fires repeatedly while a split or the
 * dock settles, so forwarding unconditionally makes a program repaint at
 * several widths in a row and leaves torn, overlapping rows on screen.
 * Un-laid-out containers measure as 0 and would wedge the child at a bogus size.
 */
export function shouldResizePty(state: PtyResizeState): boolean {
  if (!state.cols || !state.rows) return false;
  if (!Number.isFinite(state.cols) || !Number.isFinite(state.rows)) return false;
  return state.cols !== state.ptyCols || state.rows !== state.ptyRows;
}
