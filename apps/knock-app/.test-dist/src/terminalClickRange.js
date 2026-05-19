const CONTINUATION_PROMPT_RE = /^\s*(?:>|quote>|dquote>|bquote>|cmdsubst>|heredoc>|pipe>|continuation>)\s?/i;
const PROMPT_ONLY_RE = /^\s*[$#>%❯➜→λ]+\s*$/u;
const MULTILINE_CONTINUATION_RE = /^\s*(?:[-"'`~)}\]>{|&]|[([{,])/;
function getLine(buffer, row) {
    if (row < 0 || row >= buffer.length)
        return null;
    return buffer.getLine(row);
}
function getLineText(buffer, row) {
    return getLine(buffer, row)?.text ?? "";
}
function getPromptCols(lineText) {
    const match = lineText.match(CONTINUATION_PROMPT_RE);
    return match ? match[0].length : 0;
}
function getLineTextEnd(lineText) {
    return lineText.trimEnd().length;
}
function isPromptOnlyRowText(lineText) {
    return PROMPT_ONLY_RE.test(lineText.trim());
}
function isMultilineContinuationText(lineText) {
    return MULTILINE_CONTINUATION_RE.test(lineText);
}
function getEditableRowSegment(buffer, row) {
    const line = getLine(buffer, row);
    if (!line)
        return null;
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
function isContinuationRow(buffer, row) {
    const line = getLine(buffer, row);
    if (!line || line.isWrapped)
        return false;
    return CONTINUATION_PROMPT_RE.test(getLineText(buffer, row));
}
function shouldAttachToPreviousRow(buffer, row) {
    if (row <= 0)
        return false;
    const line = getLine(buffer, row);
    if (!line)
        return false;
    const lineText = getLineText(buffer, row).trimEnd();
    const prevText = getLineText(buffer, row - 1).trimEnd();
    return (line.isWrapped ||
        isContinuationRow(buffer, row) ||
        isMultilineContinuationText(lineText) ||
        isPromptOnlyRowText(prevText));
}
export function collectEditableSegments(buffer) {
    let startRow = buffer.cursorRow;
    while (startRow > 0 && shouldAttachToPreviousRow(buffer, startRow)) {
        startRow -= 1;
    }
    const segments = [];
    let row = startRow;
    while (row < buffer.length) {
        const segment = getEditableRowSegment(buffer, row);
        if (!segment)
            break;
        segments.push(segment);
        const nextRow = row + 1;
        if (nextRow >= buffer.length)
            break;
        if (isPromptOnlyRowText(getLineText(buffer, row).trimEnd()) ||
            shouldAttachToPreviousRow(buffer, nextRow)) {
            row += 1;
            continue;
        }
        break;
    }
    return segments;
}
export function getSegmentOffset(segments, row, col) {
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
