const CONTINUATION_PROMPT_RE =
  /^\s*(?:>|quote>|dquote>|bquote>|cmdsubst>|heredoc>|pipe>|continuation>)\s?/i;
const PROMPT_ONLY_RE = /^\s*[$#>%❯➜→λ]+\s*$/u;
const MULTILINE_CONTINUATION_RE = /^\s*(?:[-"'`~)}\]>{|&]|[([{,])/;

export interface TerminalClickLine {
  text: string;
  isWrapped: boolean;
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
): EditableRowSegment | null {
  const line = getLine(buffer, row);
  if (!line) return null;
  const lineText = getLineText(buffer, row);
  if (isPromptOnlyRowText(lineText)) {
    return { row, promptCols: getLineTextEnd(lineText), editableCols: 0 };
  }
  const promptCols = line.isWrapped ? 0 : getPromptCols(lineText);
  const nextLine = getLine(buffer, row + 1);
  const editableCols = nextLine?.isWrapped
    ? Math.max(0, buffer.cols - promptCols)
    : Math.max(0, lineText.trimEnd().length - promptCols);
  return { row, promptCols, editableCols };
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

export function collectEditableSegments(buffer: TerminalClickBuffer): EditableRowSegment[] {
  let startRow = buffer.cursorRow;
  while (startRow > 0 && shouldAttachToPreviousRow(buffer, startRow)) {
    startRow -= 1;
  }
  const segments: EditableRowSegment[] = [];
  let row = startRow;
  while (row < buffer.length) {
    const segment = getEditableRowSegment(buffer, row);
    if (!segment) break;
    segments.push(segment);
    const nextRow = row + 1;
    if (nextRow >= buffer.length) break;
    if (
      isPromptOnlyRowText(getLineText(buffer, row).trimEnd()) ||
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
}

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
