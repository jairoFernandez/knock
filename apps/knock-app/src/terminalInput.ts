// Pure input/clipboard/menu rules for the embedded terminal. Kept free of DOM
// and xterm imports so they can be unit-tested under plain Node.

export interface InputRouteState {
  /** Session id generated before spawning (known before the backend replies). */
  sessionId: string | null;
  /** terminal_spawn resolved, so the backend owns the session. */
  spawned: boolean;
  /** At least one PTY chunk arrived for this session. */
  outputSeen: boolean;
  exited: boolean;
}

/**
 * Where xterm's onData should go: the session id to write to, or null to drop.
 *
 * Output reaching us proves the backend session already exists (the reader
 * thread starts after it is registered), even when terminal_spawn has not
 * resolved yet. That window matters: shells and prompts query the terminal on
 * startup (cursor position ESC[6n, device attributes ESC[c, background color
 * OSC 11) and block until xterm answers. Dropping those answers left the first
 * terminal of a session hung, because a cold spawn resolves later than the
 * shell's first query.
 *
 * Keys typed before the shell exists at all are still dropped: there is no
 * prompt to receive them and they would show up as a bogus first command.
 */
export function resolveInputTarget(state: InputRouteState): string | null {
  if (state.exited || !state.sessionId) return null;
  if (state.spawned || state.outputSeen) return state.sessionId;
  return null;
}

/** Enter on an exited pane restarts its shell, like Warp/VS Code. */
export function shouldRestartOnInput(exited: boolean, data: string): boolean {
  return exited && (data === "\r" || data === "\n");
}

export type TerminalKeyAction = "copy" | "paste" | "selectAll" | "clear" | "find";

export interface KeyLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Map a keydown to a terminal-level action, or null to let xterm handle it.
 *
 * macOS: Cmd+C/K/F/A. Cmd+V is left to the native paste event, which xterm
 * already turns into a (bracketed) paste without the clipboard-permission
 * prompt WebKit shows for programmatic reads.
 *
 * Elsewhere: Ctrl+Shift+C/V/F/K/A, and Ctrl+C copies only while text is
 * selected — otherwise it must still reach the shell as SIGINT.
 */
export function getTerminalKeyAction(
  ev: KeyLike,
  opts: { isMac: boolean; hasSelection: boolean },
): TerminalKeyAction | null {
  if (ev.type !== "keydown" || ev.altKey) return null;
  const key = ev.key.toLowerCase();
  if (opts.isMac) {
    if (!ev.metaKey || ev.ctrlKey || ev.shiftKey) return null;
    if (key === "c") return opts.hasSelection ? "copy" : null;
    if (key === "k") return "clear";
    if (key === "f") return "find";
    if (key === "a") return "selectAll";
    return null;
  }
  if (!ev.ctrlKey || ev.metaKey) return null;
  if (ev.shiftKey) {
    if (key === "c") return "copy";
    if (key === "v") return "paste";
    if (key === "f") return "find";
    if (key === "k") return "clear";
    if (key === "a") return "selectAll";
    return null;
  }
  if (key === "c" && opts.hasSelection) return "copy";
  return null;
}

/**
 * Normalize text copied out of the terminal: xterm pads short rows with
 * spaces up to the selection edge, so a copied block of lines carries
 * trailing whitespace that breaks pasted commands and diffs.
 */
export function cleanCopiedText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}

/** Keep a context menu fully inside the viewport. */
export function clampMenuPosition(
  x: number,
  y: number,
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 6,
): { x: number; y: number } {
  const maxX = Math.max(margin, viewport.width - menu.width - margin);
  const maxY = Math.max(margin, viewport.height - menu.height - margin);
  return {
    x: Math.min(Math.max(margin, x), maxX),
    y: Math.min(Math.max(margin, y), maxY),
  };
}

/** Links are opened only with Cmd/Ctrl held, so plain clicks keep selecting. */
export function shouldOpenLink(
  ev: { metaKey: boolean; ctrlKey: boolean },
  isMac: boolean,
): boolean {
  return isMac ? ev.metaKey : ev.ctrlKey;
}

export function isOpenableUrl(uri: string): boolean {
  return /^https?:\/\//i.test(uri.trim());
}
