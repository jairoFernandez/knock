// Pure helpers for the notes view (no DOM, no Tauri): unit-tested in tests/notesModel.test.mjs.

export type NoteScope = "global" | "workspace";

export interface NoteMeta {
  name: string;
  encrypted: boolean;
  /** Milliseconds since the Unix epoch. */
  modified: number;
  sizeBytes: number;
}

const MAX_NAME_CHARS = 80;

/** Mirrors `knock_core::notes::validate_name`. Returns an error message or null. */
export function validateNoteName(name: string): string | null {
  if (!name.trim()) return "Name cannot be empty";
  if (name !== name.trim()) return "Name cannot start or end with spaces";
  if (name.startsWith(".")) return "Name cannot start with a dot";
  if (name.endsWith(".")) return "Name cannot end with a dot";
  if ([...name].length > MAX_NAME_CHARS) return `Name is longer than ${MAX_NAME_CHARS} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\:*?"<>|]/.test(name)) return 'Name cannot contain / \\ : * ? " < > |';
  return null;
}

/** `base`, or `base 2`, `base 3`… whichever is free (case-insensitive). */
export function uniqueName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function filterNotes<T extends { name: string }>(notes: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...notes];
  return notes.filter((n) => n.name.toLowerCase().includes(q));
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const TASK = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\](?:\s|$))/;

/**
 * Flip the `index`-th task checkbox (`- [ ]` / `- [x]`), counting in document
 * order like the rendered preview does: lines inside fenced code are skipped.
 * Returns the source unchanged when there is no such task.
 */
export function toggleTask(src: string, index: number): string {
  const lines = src.split("\n");
  let fence: string | null = null;
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      const marker = f[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = TASK.exec(line);
    if (!m) continue;
    if (seen === index) {
      const next = m[2] === " " ? "x" : " ";
      lines[i] = m[1] + next + m[3] + line.slice(m[0].length);
      return lines.join("\n");
    }
    seen++;
  }
  return src;
}

export function noteStats(text: string): { words: number; lines: number } {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const lines = text ? text.split("\n").length : 0;
  return { words, lines };
}

/** Compact age label for the note list: now, 5m, 3h, 2d, then a date. */
export function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(ms);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short" });
}

const LIST_ITEM = /^(\s*(?:>\s*)*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;

/**
 * What Enter should do at the end of `line` in the editor: continue the list
 * with the next bullet (`prefix`), or end it (`clear`) when the item is empty.
 * Null when the line is not a list item.
 */
export function listContinuation(line: string): { prefix: string } | { clear: true } | null {
  const m = LIST_ITEM.exec(line);
  if (!m) return null;
  if (line.slice(m[0].length).trim() === "") return { clear: true };
  const [, lead, bullet, num, delim, gap, task] = m;
  const marker = num !== undefined ? `${Number(num) + 1}${delim}` : bullet;
  return { prefix: `${lead}${marker}${gap}${task ? "[ ] " : ""}` };
}
