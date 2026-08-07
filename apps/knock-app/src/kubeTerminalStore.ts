// Global, in-memory store for embedded kubeconfig terminals.
//
// xterm.js Terminal instances and their DOM containers are kept alive for the
// lifetime of the app: switching tabs/entries or rearranging splits never
// destroys an instance, so scrollback survives. Backend PTY sessions remain
// running too — they're attached on the Rust side in `TerminalSessions` and
// only die on RunEvent::Exit or explicit close.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  collectEditableSegments,
  getSegmentOffset,
  type TerminalClickBuffer,
} from "./terminalClickRange";

export type Pane =
  | { kind: "leaf"; termId: string }
  | { kind: "split"; orientation: "h" | "v"; ratio: number; a: Pane; b: Pane };

export interface Tab {
  id: string;
  label: string;
  layout: Pane;
  activeLeaf: string; // termId of focused leaf
}

export interface KubeTerminalSpawnArgs {
  name?: string | null;
  project?: string | null;
  encrypted?: boolean;
  passphrase: string | null;
  cwd?: string | null;
  title?: string | null;
  /** Shell id (cmd/powershell/pwsh/git-bash/wsl/zsh/bash/fish), or "auto". */
  shell?: string | null;
}

export interface ShellInfo {
  id: string;
  label: string;
  available: boolean;
}

export interface TerminalEntry {
  id: string;            // stable termId (uuid)
  name: string | null;   // kubeconfig name, null for a plain shell
  project: string | null; // kubeconfig project, null for a plain shell
  encrypted: boolean;
  cwd: string | null;
  shell: string | null;       // shell id, "auto" => backend default
  sessionId: string | null;   // backend session id (null until spawned)
  term: Terminal;
  fit: FitAddon;
  container: HTMLDivElement;  // the persistent DOM element
  unlisten: UnlistenFn[];
  exited: boolean;
  spawning: boolean;
  /** User-editable title (default: kubeconfig name). */
  title: string;
  /** Color tag (CSS color). */
  color: string;
}

/** Distinct, dark-mode-friendly colors used to tag terminal sessions. */
export const SESSION_COLORS = [
  "#4a90e2", // blue
  "#22c55e", // green
  "#a78bfa", // purple
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#14b8a6", // teal
] as const;

function nextColor(used: Set<string>): string {
  for (const c of SESSION_COLORS) {
    if (!used.has(c)) return c;
  }
  return SESSION_COLORS[used.size % SESSION_COLORS.length];
}

type Listener = () => void;

function getBufferRowFromViewport(term: Terminal, viewportRow: number): number {
  return term.buffer.active.viewportY + viewportRow;
}

function getClickBuffer(term: Terminal): TerminalClickBuffer {
  const buf = term.buffer.active;
  return {
    cols: term.cols,
    cursorRow: buf.baseY + buf.cursorY,
    cursorCol: buf.cursorX,
    length: buf.length,
    getLine(row) {
      const line = buf.getLine(row);
      if (!line) return null;
      return {
        text: line.translateToString(false, 0, term.cols),
        isWrapped: line.isWrapped,
      };
    },
  };
}

class Store {
  tabs: Tab[] = [];
  activeTabId: string | null = null;
  terminals = new Map<string, TerminalEntry>();
  revision = 0;
  private listeners = new Set<Listener>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit() {
    this.revision += 1;
    for (const l of this.listeners) l();
  }

  getActiveTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  setActiveTab(id: string) {
    this.activeTabId = id;
    this.emit();
  }

  /**
   * Create a new tab containing a single fresh terminal leaf. It may be bound
   * to a kubeconfig, or it may be a plain shell.
   */
  async openNewTab(args: KubeTerminalSpawnArgs): Promise<string> {
    const t = this.createTerminal(args);
    const tabId = `t-${cryptoRandom()}`;
    const label = t.title;
    const tab: Tab = {
      id: tabId,
      label,
      layout: { kind: "leaf", termId: t.id },
      activeLeaf: t.id,
    };
    this.tabs.push(tab);
    this.activeTabId = tabId;
    this.emit();
    await this.spawn(t);
    return tabId;
  }

  async openGeneralTab(
    args: { cwd?: string | null; title?: string | null; shell?: string | null } = {},
  ): Promise<string> {
    return this.openNewTab({
      name: null,
      project: null,
      encrypted: false,
      passphrase: null,
      cwd: args.cwd ?? null,
      title: args.title ?? "Shell",
      shell: args.shell ?? null,
    });
  }

  /**
   * Create a new tab using the active terminal's kubeconfig. This keeps the
   * bottom dock useful after the user navigates away from the kubeconfig view.
   */
  async openNewTabFromActive(): Promise<string | null> {
    const tab = this.getActiveTab();
    if (!tab) return null;
    const src = this.terminals.get(tab.activeLeaf);
    if (!src) return null;
    return this.openNewTab({
      name: src.name,
      project: src.project,
      encrypted: src.encrypted,
      passphrase: null,
      cwd: src.cwd,
      title: src.name ? src.title : "Shell",
      shell: src.shell,
    });
  }

  /**
   * Split the active leaf in the active tab. New leaf binds to same
   * (name, project, passphrase) as the source leaf.
   */
  async splitActive(orientation: "h" | "v"): Promise<void> {
    const tab = this.getActiveTab();
    if (!tab) return;
    const src = this.terminals.get(tab.activeLeaf);
    if (!src) return;
    const t = this.createTerminal({
      name: src.name,
      project: src.project,
      encrypted: src.encrypted,
      passphrase: null, // temp file is already cached after the first spawn
      cwd: src.cwd,
      title: src.name ? undefined : "Shell",
      shell: src.shell,
    });
    tab.layout = replaceLeaf(tab.layout, tab.activeLeaf, {
      kind: "split",
      orientation,
      ratio: 0.5,
      a: { kind: "leaf", termId: tab.activeLeaf },
      b: { kind: "leaf", termId: t.id },
    });
    tab.activeLeaf = t.id;
    this.emit();
    await this.spawn(t);
  }

  /**
   * Close an entire terminal tab and kill every leaf/subshell in it.
   */
  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const leafIds = collectLeaves(tab.layout).map((leaf) => leaf.termId);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[0]?.id ?? null;
    }
    await Promise.all(leafIds.map((termId) => this.disposeTerminal(termId)));
    this.emit();
  }

  /**
   * Close a leaf — kills its backend session and removes it from the layout.
   * If the tab becomes empty, the tab is removed.
   */
  async closeLeaf(tabId: string, termId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const next = removeLeaf(tab.layout, termId);
    if (next === null) {
      // tab now empty
      this.tabs = this.tabs.filter((t) => t.id !== tabId);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs[0]?.id ?? null;
      }
    } else {
      tab.layout = next;
      if (tab.activeLeaf === termId) {
        const firstLeaf = collectLeaves(next)[0];
        tab.activeLeaf = firstLeaf?.termId ?? "";
      }
    }
    await this.disposeTerminal(termId);
    this.emit();
  }

  setLeafActive(tabId: string, termId: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.activeLeaf = termId;
    this.emit();
  }

  setSplitRatio(tabId: string, path: number[], ratio: number) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.layout = setRatio(tab.layout, path, clamp(ratio, 0.1, 0.9));
    this.emit();
  }

  private createTerminal(args: {
    name?: string | null;
    project?: string | null;
    encrypted?: boolean;
    passphrase: string | null;
    cwd?: string | null;
    title?: string | null;
    shell?: string | null;
    color?: string;
  }): TerminalEntry {
    const id = `term-${cryptoRandom()}`;
    const container = document.createElement("div");
    container.className = "kube-xterm";
    container.style.width = "100%";
    container.style.height = "100%";

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 12,
      theme: { background: "#0f1115", foreground: "#d4d4d8" },
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    const usedColors = new Set<string>();
    for (const t of this.terminals.values()) usedColors.add(t.color);

    const entry: TerminalEntry = {
      id,
      name: args.name ?? null,
      project: args.project ?? null,
      encrypted: args.encrypted ?? false,
      cwd: args.cwd ?? null,
      shell: args.shell ?? null,
      sessionId: null,
      term,
      fit,
      container,
      unlisten: [],
      exited: false,
      spawning: false,
      title: args.title ?? args.name ?? "Shell",
      color: args.color ?? nextColor(usedColors),
    };

    // Buffer user input until the backend session id arrives.
    const pending: string[] = [];
    term.onData((d) => {
      if (entry.sessionId) {
        invoke("terminal_write", { sessionId: entry.sessionId, data: d }).catch(
          () => undefined,
        );
      } else {
        pending.push(d);
      }
    });
    (entry as TerminalEntry & { pending?: string[] }).pending = pending;
    (entry as TerminalEntry & { initialPassphrase?: string | null }).initialPassphrase =
      args.passphrase;

    // Click-to-position-cursor on the active editable buffer region.
    // This supports wrapped input plus common shell continuation prompts by
    // translating a click into N ← / → arrow keys sent through the PTY.
    let clickStart: { x: number; y: number } | null = null;
    container.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      clickStart = { x: ev.clientX, y: ev.clientY };
    });
    container.addEventListener("mouseup", (ev) => {
      if (ev.button !== 0) return;
      const start = clickStart;
      clickStart = null;
      if (!start) return;
      // Ignore drags (user is selecting text)
      const dx = Math.abs(ev.clientX - start.x);
      const dy = Math.abs(ev.clientY - start.y);
      if (dx > 3 || dy > 3) return;
      // Ignore if user has an active selection
      const sel = term.getSelection();
      if (sel && sel.length > 0) return;

      const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
      const target = screen ?? container;
      const rect = target.getBoundingClientRect();
      const cellW = rect.width / Math.max(1, term.cols);
      const cellH = rect.height / Math.max(1, term.rows);
      const col = Math.floor((ev.clientX - rect.left) / cellW);
      const viewportRow = Math.floor((ev.clientY - rect.top) / cellH);
      if (col < 0 || viewportRow < 0 || col >= term.cols || viewportRow >= term.rows) return;
      const targetRow = getBufferRowFromViewport(term, viewportRow);
      const clickBuffer = getClickBuffer(term);
      const segments = collectEditableSegments(clickBuffer);
      if (segments.length === 0) return;
      const firstRow = segments[0]?.row ?? 0;
      const lastRow = segments[segments.length - 1]?.row ?? 0;
      if (targetRow < firstRow || targetRow > lastRow) return;
      const targetOffset = getSegmentOffset(segments, targetRow, col);
      const cursorOffset = getSegmentOffset(segments, clickBuffer.cursorRow, clickBuffer.cursorCol);
      if (targetOffset === null || cursorOffset === null) return;
      const delta = targetOffset - cursorOffset;
      if (delta === 0) return;
      const seq = delta > 0 ? "\x1b[C".repeat(delta) : "\x1b[D".repeat(-delta);
      const sid = entry.sessionId;
      if (sid) {
        invoke("terminal_write", { sessionId: sid, data: seq }).catch(() => undefined);
      }
    });

    this.terminals.set(id, entry);
    return entry;
  }

  private async spawn(entry: TerminalEntry): Promise<void> {
    if (entry.spawning || entry.sessionId) return;
    entry.spawning = true;
    try {
      const e = entry as TerminalEntry & {
        pending?: string[];
        initialPassphrase?: string | null;
      };
      const sessionId = await invoke<string>("terminal_spawn", {
        name: entry.name,
        project: entry.project,
        passphrase: e.initialPassphrase ?? null,
        cwd: entry.cwd,
        cols: entry.term.cols || 80,
        rows: entry.term.rows || 24,
        shell: entry.shell ?? "auto",
      });
      entry.sessionId = sessionId;

      const dataEvt = `terminal:data:${sessionId}`;
      const exitEvt = `terminal:exit:${sessionId}`;
      const u1 = await listen<string>(dataEvt, (e) => {
        entry.term.write(decodeBase64(e.payload));
      });
      const u2 = await listen<void>(exitEvt, () => {
        entry.term.write("\r\n[process exited]\r\n");
        entry.exited = true;
        this.emit();
      });
      entry.unlisten.push(u1, u2);

      // Flush pending input typed before sessionId existed.
      if (e.pending && e.pending.length) {
        const flush = e.pending.join("");
        e.pending = [];
        await invoke("terminal_write", { sessionId, data: flush }).catch(
          () => undefined,
        );
      }
    } catch (err) {
      entry.term.write(`\r\n[failed to spawn shell: ${String(err)}]\r\n`);
      entry.exited = true;
    } finally {
      entry.spawning = false;
      this.emit();
    }
  }

  private async disposeTerminal(termId: string): Promise<void> {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    for (const u of entry.unlisten) {
      try {
        u();
      } catch {
        /* no-op */
      }
    }
    if (entry.sessionId) {
      invoke("terminal_kill", { sessionId: entry.sessionId }).catch(() => undefined);
    }
    try {
      entry.term.dispose();
    } catch {
      /* no-op */
    }
    this.terminals.delete(termId);
  }

  resizeLeaf(termId: string) {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    try {
      entry.fit.fit();
    } catch {
      /* no-op */
    }
    if (entry.sessionId) {
      invoke("terminal_resize", {
        sessionId: entry.sessionId,
        cols: entry.term.cols,
        rows: entry.term.rows,
      }).catch(() => undefined);
    }
  }

  setTerminalTitle(termId: string, title: string) {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    entry.title = title;
    // Keep single-leaf tab labels in sync with their terminal's title.
    for (const tab of this.tabs) {
      if (tab.layout.kind === "leaf" && tab.layout.termId === termId) {
        tab.label = title;
      }
    }
    this.emit();
  }

  renameTab(tabId: string, label: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.label = label;
    if (tab.layout.kind === "leaf") {
      const entry = this.terminals.get(tab.layout.termId);
      if (entry) entry.title = label;
    }
    this.emit();
  }

  setTerminalColor(termId: string, color: string) {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    entry.color = color;
    this.emit();
  }

  focusLeaf(termId: string) {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    try {
      entry.term.focus();
    } catch {
      /* no-op */
    }
  }
}

export const terminalStore = new Store();

/** List the shells the embedded PTY can launch on this OS. Cached after first call. */
let shellsCache: ShellInfo[] | null = null;
export async function listShells(): Promise<ShellInfo[]> {
  if (shellsCache) return shellsCache;
  try {
    shellsCache = await invoke<ShellInfo[]>("terminal_list_shells");
  } catch {
    shellsCache = [{ id: "auto", label: "Default shell", available: true }];
  }
  return shellsCache;
}

// -------- Pane tree helpers --------

export function collectLeaves(p: Pane): { kind: "leaf"; termId: string }[] {
  if (p.kind === "leaf") return [p];
  return [...collectLeaves(p.a), ...collectLeaves(p.b)];
}

function replaceLeaf(p: Pane, termId: string, replacement: Pane): Pane {
  if (p.kind === "leaf") {
    return p.termId === termId ? replacement : p;
  }
  return {
    ...p,
    a: replaceLeaf(p.a, termId, replacement),
    b: replaceLeaf(p.b, termId, replacement),
  };
}

function removeLeaf(p: Pane, termId: string): Pane | null {
  if (p.kind === "leaf") return p.termId === termId ? null : p;
  const a = removeLeaf(p.a, termId);
  const b = removeLeaf(p.b, termId);
  if (a === null && b === null) return null;
  if (a === null) return b!;
  if (b === null) return a!;
  return { ...p, a, b };
}

function setRatio(p: Pane, path: number[], ratio: number): Pane {
  if (path.length === 0) {
    if (p.kind === "split") return { ...p, ratio };
    return p;
  }
  if (p.kind !== "split") return p;
  const [head, ...rest] = path;
  if (head === 0) return { ...p, a: setRatio(p.a, rest, ratio) };
  if (head === 1) return { ...p, b: setRatio(p.b, rest, ratio) };
  return p;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
