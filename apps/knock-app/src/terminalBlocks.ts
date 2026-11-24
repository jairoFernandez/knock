// Command blocks built from OSC 133 shell-integration marks (Warp-style).
// Pure: positions are opaque handles resolved through `lineOf`, so the store
// can back them with xterm markers (which follow scrolling and reflow) and the
// tests with plain numbers.

export type ShellMarkKind = "A" | "B" | "C" | "D";

export interface ShellMark {
  kind: ShellMarkKind;
  exitCode: number | null;
}

/** Parse the payload of `ESC ] 133 ; <payload> BEL`. */
export function parseOsc133(payload: string): ShellMark | null {
  const [head, ...rest] = payload.split(";");
  if (head !== "A" && head !== "B" && head !== "C" && head !== "D") return null;
  let exitCode: number | null = null;
  if (head === "D" && rest.length > 0 && /^-?\d+$/.test(rest[0])) {
    exitCode = Number(rest[0]);
  }
  return { kind: head, exitCode };
}

export type BlockState = "prompt" | "running" | "done";

export interface Pos<M> {
  at: M;
  col: number;
}

export interface Block<M> {
  id: number;
  state: BlockState;
  /** First row of the prompt. */
  prompt: M;
  /** Where typed input starts (end of the prompt). */
  input: Pos<M> | null;
  /** Where command output starts. */
  output: Pos<M> | null;
  /** Where the command finished. */
  end: Pos<M> | null;
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export type LineOf<M> = (m: M) => number;

export class BlockTracker<M> {
  blocks: Block<M>[] = [];
  private nextId = 1;

  /** @param release frees a position handle the tracker no longer uses. */
  constructor(private release: (m: M) => void = () => undefined) {}

  get current(): Block<M> | null {
    return this.blocks[this.blocks.length - 1] ?? null;
  }

  /** Whether the shell has ever sent a mark: blocks are only drawn then. */
  get active(): boolean {
    return this.blocks.length > 0;
  }

  apply(mark: ShellMark, pos: Pos<M>, now: number): void {
    const cur = this.current;
    switch (mark.kind) {
      case "A": {
        // A prompt redrawn in place (resize, reset-prompt, an empty Enter
        // that produced no command) replaces the pending block instead of
        // leaving empty blocks behind.
        if (cur && cur.state === "prompt") {
          this.release(cur.prompt);
          if (cur.input) this.release(cur.input.at);
          cur.prompt = pos.at;
          cur.input = null;
          return;
        }
        this.blocks.push({
          id: this.nextId++,
          state: "prompt",
          prompt: pos.at,
          input: null,
          output: null,
          end: null,
          exitCode: null,
          startedAt: null,
          finishedAt: null,
        });
        return;
      }
      case "B":
        if (cur && cur.state === "prompt") {
          if (cur.input) this.release(cur.input.at);
          cur.input = pos;
        } else {
          this.release(pos.at);
        }
        return;
      case "C":
        if (cur && cur.state === "prompt") {
          cur.state = "running";
          cur.output = pos;
          cur.startedAt = now;
        } else {
          this.release(pos.at);
        }
        return;
      case "D":
        // Some shells only report the exit (no C): the block is still done.
        if (cur && cur.state !== "done") {
          cur.state = "done";
          cur.end = pos;
          cur.exitCode = mark.exitCode;
          cur.finishedAt = now;
        } else {
          this.release(pos.at);
        }
        return;
    }
  }

  /** Drop blocks whose prompt scrolled out of the buffer or was cleared. */
  prune(lineOf: LineOf<M>): void {
    const keep: Block<M>[] = [];
    for (const b of this.blocks) {
      if (lineOf(b.prompt) < 0) {
        this.releaseBlock(b);
      } else {
        keep.push(b);
      }
    }
    this.blocks = keep;
  }

  clear(): void {
    for (const b of this.blocks) this.releaseBlock(b);
    this.blocks = [];
  }

  private releaseBlock(b: Block<M>) {
    this.release(b.prompt);
    if (b.input) this.release(b.input.at);
    if (b.output) this.release(b.output.at);
    if (b.end) this.release(b.end.at);
  }

  /**
   * Row range `[start, end)` each block covers. A block runs until the next
   * prompt; the last one until `bufferEnd`.
   */
  ranges(lineOf: LineOf<M>, bufferEnd: number): { block: Block<M>; start: number; end: number }[] {
    const out: { block: Block<M>; start: number; end: number }[] = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const start = lineOf(b.prompt);
      if (start < 0) continue;
      const next = this.blocks[i + 1];
      const end = next ? lineOf(next.prompt) : bufferEnd;
      out.push({ block: b, start, end: Math.max(start + 1, end) });
    }
    return out;
  }

  blockAtLine(line: number, lineOf: LineOf<M>, bufferEnd: number): Block<M> | null {
    for (const r of this.ranges(lineOf, bufferEnd)) {
      if (line >= r.start && line < r.end) return r.block;
    }
    return null;
  }

  /** The shell is waiting at a prompt whose input start is known. */
  inputAnchor(lineOf: LineOf<M>): { row: number; col: number } | null {
    const cur = this.current;
    if (!cur || cur.state !== "prompt" || !cur.input) return null;
    const row = lineOf(cur.input.at);
    return row < 0 ? null : { row, col: cur.input.col };
  }

  /** A command is running: clicks must not be turned into arrow keys. */
  get commandRunning(): boolean {
    return this.current?.state === "running";
  }

  /** Finished blocks, oldest first, for keyboard navigation. */
  finished(): Block<M>[] {
    return this.blocks.filter((b) => b.state === "done");
  }
}

/** Short duration label: 840ms, 3.2s, 1m 05s, 2h 03m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Badge shown on a finished block. */
export function blockBadge(b: { exitCode: number | null; startedAt: number | null; finishedAt: number | null }): {
  text: string;
  failed: boolean;
} | null {
  const failed = b.exitCode !== null && b.exitCode !== 0;
  const dur =
    b.startedAt !== null && b.finishedAt !== null ? formatDuration(b.finishedAt - b.startedAt) : "";
  if (!failed && !dur) return null;
  const parts = [];
  if (failed) parts.push(`exit ${b.exitCode}`);
  if (dur) parts.push(dur);
  return { text: parts.join(" · "), failed };
}

export interface TextRow {
  text: string;
  isWrapped: boolean;
}

/**
 * Text between two buffer positions, joining soft-wrapped rows and keeping
 * real line breaks. `end` is exclusive. `getRow` slices by column (cells), so
 * wide characters in a prompt do not shift the cut.
 */
export function textBetween(
  getRow: (row: number, startCol: number, endCol?: number) => TextRow | null,
  start: { row: number; col: number },
  end: { row: number; col: number },
): string {
  const lines: string[] = [];
  for (let row = start.row; row <= end.row; row++) {
    const startCol = row === start.row ? start.col : 0;
    // The end sits at (or before) the start of this row: nothing of it is included.
    if (row === end.row && end.col <= startCol) break;
    const r = getRow(row, startCol, row === end.row ? end.col : undefined);
    if (!r) break;
    if (r.isWrapped && lines.length > 0 && row !== start.row) {
      lines[lines.length - 1] += r.text;
    } else {
      lines.push(r.text);
    }
  }
  return lines
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
