// Global, in-memory store for embedded kubeconfig terminals.
//
// xterm.js Terminal instances and their DOM containers are kept alive for the
// lifetime of the app: switching tabs/entries or rearranging splits never
// destroys an instance, so scrollback survives. Backend PTY sessions remain
// running too — they're attached on the Rust side in `TerminalSessions` and
// only die on RunEvent::Exit or explicit close.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal, type IBufferCell, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  arrowPressesBetween,
  CLICK_MOVE_DELAY_MS,
  collectEditableSegments,
  columnAtPixel,
  findGhostStart,
  getSegmentOffset,
  shouldMoveCursorForClick,
  shouldResizePty,
  type TerminalClickBuffer,
} from "./terminalClickRange";
import {
  cleanCopiedText,
  getTerminalKeyAction,
  isOpenableUrl,
  resolveInputTarget,
  shouldOpenLink,
  shouldRestartOnInput,
  type TerminalKeyAction,
} from "./terminalInput";
import {
  collectLeaves,
  leafAfterClose,
  removeLeaf,
  replaceLeaf,
  setRatio,
  type Pane,
} from "./terminalLayout";
import {
  BlockTracker,
  blockBadge,
  parseOsc133,
  textBetween,
  type Block,
} from "./terminalBlocks";

export { collectLeaves, type Pane };

export const IS_MAC =
  typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** Shortcut label for the current platform, e.g. "⌘K" or "Ctrl+Shift+K". */
export function shortcutLabel(key: string, opts: { shift?: boolean } = {}): string {
  if (IS_MAC) return `${opts.shift ? "⇧" : ""}⌘${key.toUpperCase()}`;
  return `Ctrl+${opts.shift ? "Shift+" : ""}${key.toUpperCase()}`;
}

export const TERMINAL_BG = "#121418";

const TERMINAL_THEME = {
  background: TERMINAL_BG,
  foreground: "#e3e6ec",
  cursor: "#8fb4ff",
  cursorAccent: TERMINAL_BG,
  selectionBackground: "rgba(122, 162, 255, 0.32)",
  selectionInactiveBackground: "rgba(122, 162, 255, 0.16)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.10)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.24)",
  black: "#1e2127",
  red: "#ff6b6b",
  green: "#5fd38d",
  yellow: "#f5c26b",
  blue: "#6ea8fe",
  magenta: "#c792ea",
  cyan: "#56d4dd",
  white: "#c8ccd4",
  brightBlack: "#5c6370",
  brightRed: "#ff8787",
  brightGreen: "#7ee2a8",
  brightYellow: "#ffd58a",
  brightBlue: "#8fbcff",
  brightMagenta: "#dcaaf5",
  brightCyan: "#7ee7ee",
  brightWhite: "#ffffff",
};

const SEARCH_DECORATIONS = {
  matchBackground: "#5c4a1a",
  matchBorder: "#5c4a1a",
  matchOverviewRuler: "#f5c26b",
  activeMatchBackground: "#b8860b",
  activeMatchBorder: "#ffd58a",
  activeMatchColorOverviewRuler: "#ffd58a",
};

export interface SearchState {
  query: string;
  caseSensitive: boolean;
  resultIndex: number;
  resultCount: number;
}

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
  search: SearchAddon;
  /** terminal_spawn resolved for the current sessionId. */
  spawned: boolean;
  /** A PTY chunk arrived for the current sessionId. */
  outputSeen: boolean;
  container: HTMLDivElement;  // the persistent DOM element
  unlisten: UnlistenFn[];
  exited: boolean;
  spawning: boolean;
  /** User-editable title (default: kubeconfig name). */
  title: string;
  /** Color tag (CSS color). */
  color: string;
  /**
   * Timestamp (ms) of the last PTY chunk written into the emulator. Used to
   * suppress click-to-position-cursor while output is streaming.
   */
  lastWriteAt: number;
  /** Pending rAF handle coalescing a burst of resize notifications. */
  resizeFrame: number | null;
  /** Tears down a focus attempt still waiting for the container to be laid out. */
  pendingFocus: (() => void) | null;
  /** Geometry last sent to the PTY, so identical resizes aren't re-sent. */
  ptyCols: number;
  ptyRows: number;
  /** Passphrase for the first spawn only; the decrypted file is cached after. */
  initialPassphrase: string | null;
  /** Deferred click-to-move, cancelled by a follow-up click (double-click). */
  clickTimer: number | null;
  /** Command blocks from OSC 133 shell-integration marks. */
  blocks: BlockTracker<IMarker>;
  /** Overlay that draws block separators, status and selection. */
  blockLayer: HTMLDivElement;
  blockFrame: number | null;
  selectedBlockId: number | null;
  hoverBlockId: number | null;
}

export type BlockPart = "command" | "output" | "all";

const lineOfMarker = (m: IMarker) => (m.isDisposed ? -1 : m.line);

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

function cellFg(cell: IBufferCell): string {
  if (cell.isFgDefault()) return "d";
  return `${cell.isFgPalette() ? "p" : "rgb"}${cell.getFgColor()}`;
}

/** Faint enough to be an autosuggestion (zsh-autosuggestions uses fg=8). */
function isFaintCell(cell: IBufferCell): boolean {
  if (cell.isDim()) return true;
  if (cell.isFgPalette()) {
    const c = cell.getFgColor();
    return c === 8 || (c >= 238 && c <= 246);
  }
  if (cell.isFgRGB()) {
    const v = cell.getFgColor();
    const r = (v >> 16) & 255;
    const g = (v >> 8) & 255;
    const b = v & 255;
    const hi = Math.max(r, g, b);
    return hi - Math.min(r, g, b) < 24 && hi >= 70 && hi <= 170;
  }
  return false;
}

function getClickBuffer(term: Terminal): TerminalClickBuffer {
  const buf = term.buffer.active;
  const cursorRow = buf.baseY + buf.cursorY;
  const cursorCol = buf.cursorX;
  const cell = buf.getNullCell();
  let ghostRow = -1;
  return {
    cols: term.cols,
    cursorRow,
    cursorCol,
    length: buf.length,
    getLine(row) {
      const line = buf.getLine(row);
      if (!line) return null;
      // One character per cell so string indexes are columns.
      let text = "";
      const widths: number[] = [];
      const ghostCells = [];
      for (let x = 0; x < term.cols; x++) {
        const c = line.getCell(x, cell);
        const w = c ? c.getWidth() : 1;
        const chars = c ? c.getChars() : "";
        widths.push(w);
        text += w === 0 ? "_" : chars === "" ? " " : chars.length > 1 ? "x" : chars;
        if (row >= cursorRow) {
          ghostCells.push({
            filled: chars !== "" && chars !== " ",
            fg: c ? cellFg(c) : "d",
            faint: c ? isFaintCell(c) : false,
          });
        }
      }
      let ghostFrom: number | undefined;
      if (row === cursorRow) {
        const g = findGhostStart(ghostCells, cursorCol);
        if (g !== null) {
          ghostFrom = g;
          ghostRow = row;
        }
      } else if (ghostRow >= 0 && row === ghostRow + 1 && line.isWrapped) {
        ghostFrom = 0;
      }
      return { text, isWrapped: line.isWrapped, widths, ghostFrom };
    },
  };
}

class Store {
  tabs: Tab[] = [];
  activeTabId: string | null = null;
  terminals = new Map<string, TerminalEntry>();
  /** Pane whose find bar is open, if any. */
  findTermId: string | null = null;
  search: SearchState = { query: "", caseSensitive: false, resultIndex: -1, resultCount: 0 };
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
    const neighbor = leafAfterClose(tab.layout, termId);
    const next = removeLeaf(tab.layout, termId);
    if (this.findTermId === termId) this.findTermId = null;
    if (next === null) {
      // tab now empty
      this.tabs = this.tabs.filter((t) => t.id !== tabId);
      if (this.activeTabId === tabId) {
        this.activeTabId = this.tabs[0]?.id ?? null;
      }
    } else {
      tab.layout = next;
      if (tab.activeLeaf === termId) {
        tab.activeLeaf = neighbor ?? collectLeaves(next)[0]?.termId ?? "";
      }
    }
    await this.disposeTerminal(termId);
    this.emit();
    if (this.activeTabId === tabId && next) this.focusLeaf(tab.activeLeaf);
  }

  setLeafActive(tabId: string, termId: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.activeLeaf === termId) return;
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
      fontFamily:
        "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Monaco, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 13,
      lineHeight: 1.3,
      theme: TERMINAL_THEME,
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      // A PTY already terminates lines with CRLF. Converting again turns a bare
      // \n — which processes use to redraw a line in place (spinners, progress
      // bars) — into a line feed, so output double-spaces and the scrollback
      // fills with torn fragments.
      convertEol: false,
      scrollback: 20000,
      // Keep typing anchored to the prompt without yanking the view back to the
      // bottom on every chunk of process output.
      scrollOnUserInput: true,
      // Option+click moves the cursor in full-screen programs on macOS; Alt+drag
      // makes a column selection.
      macOptionClickForcesSelection: true,
      // Search decorations are a proposed API in xterm 6.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(
      new WebLinksAddon((ev, uri) => {
        if (!shouldOpenLink(ev, IS_MAC) || !isOpenableUrl(uri)) return;
        invoke("open_url", { url: uri }).catch(() => undefined);
      }),
    );
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
      search,
      spawned: false,
      outputSeen: false,
      container,
      unlisten: [],
      exited: false,
      spawning: false,
      title: args.title ?? args.name ?? "Shell",
      color: args.color ?? nextColor(usedColors),
      lastWriteAt: 0,
      resizeFrame: null,
      pendingFocus: null,
      ptyCols: 0,
      ptyRows: 0,
      initialPassphrase: args.passphrase,
      clickTimer: null,
      blocks: new BlockTracker<IMarker>((m) => m.dispose()),
      blockLayer: document.createElement("div"),
      blockFrame: null,
      selectedBlockId: null,
      hoverBlockId: null,
    };
    this.setupBlocks(entry);

    term.onData((d) => {
      if (shouldRestartOnInput(entry.exited, d)) {
        void this.restart(entry.id);
        return;
      }
      const target = resolveInputTarget(entry);
      if (target) {
        invoke("terminal_write", { sessionId: target, data: d }).catch(() => undefined);
      }
    });

    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      if (this.findTermId !== entry.id) return;
      this.search = { ...this.search, resultIndex, resultCount };
      this.emit();
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === "keydown" && entry.selectedBlockId !== null) {
        if (ev.key === "Escape") {
          this.selectBlock(entry, null);
          return false;
        }
      }
      const action = getTerminalKeyAction(ev, {
        isMac: IS_MAC,
        hasSelection: term.hasSelection() || entry.selectedBlockId !== null,
      });
      if (!action) {
        if (ev.type === "keydown" && entry.selectedBlockId !== null && !ev.metaKey) {
          this.selectBlock(entry, null);
        }
        return true;
      }
      ev.preventDefault();
      this.runAction(entry.id, action);
      return false;
    });

    // Click-to-position-cursor on the active editable buffer region.
    // This supports wrapped input plus common shell continuation prompts by
    // translating a click into N ← / → arrow keys sent through the PTY.
    let clickStart: { x: number; y: number } | null = null;
    const cancelPendingClick = () => {
      if (entry.clickTimer !== null) {
        window.clearTimeout(entry.clickTimer);
        entry.clickTimer = null;
      }
    };
    container.addEventListener("mousedown", (ev) => {
      cancelPendingClick();
      if (ev.button !== 0) return;
      clickStart = { x: ev.clientX, y: ev.clientY };
    });
    container.addEventListener("mouseup", (ev) => {
      if (ev.button !== 0) return;
      const start = clickStart;
      clickStart = null;
      if (!start) return;
      const dx = Math.abs(ev.clientX - start.x);
      const dy = Math.abs(ev.clientY - start.y);
      const buf = term.buffer.active;
      const plainClick =
        Math.max(dx, dy) <= 3 &&
        ev.detail <= 1 &&
        !(ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) &&
        buf.type !== "alternate" &&
        term.modes.mouseTrackingMode === "none" &&
        !term.hasSelection();
      if (!plainClick) {
        if (entry.selectedBlockId !== null) this.selectBlock(entry, null);
        return;
      }
      const canMove = shouldMoveCursorForClick({
        viewportY: buf.viewportY,
        baseY: buf.baseY,
        lastWriteAt: entry.lastWriteAt,
        now: Date.now(),
        selectionLength: 0,
        dragDistance: Math.max(dx, dy),
        clickCount: ev.detail,
      });
      const clientX = ev.clientX;
      const clientY = ev.clientY;
      entry.clickTimer = window.setTimeout(() => {
        entry.clickTimer = null;
        // Re-check what may have changed while waiting for a second click.
        if (term.hasSelection()) return;
        // Clicking a finished command selects its block, like Warp.
        const block = this.blockAtClient(entry, clientY);
        if (block && block.state === "done") {
          this.selectBlock(entry, entry.selectedBlockId === block.id ? null : block.id);
          return;
        }
        if (entry.selectedBlockId !== null) this.selectBlock(entry, null);
        if (!canMove || Date.now() - entry.lastWriteAt < 50) return;
        this.moveCursorToClick(entry, clientX, clientY);
      }, CLICK_MOVE_DELAY_MS);
    });
    container.addEventListener("mousemove", (ev) => {
      if (!entry.blocks.active) return;
      const id = this.blockAtClient(entry, ev.clientY)?.id ?? null;
      if (id !== entry.hoverBlockId) {
        entry.hoverBlockId = id;
        this.scheduleBlockPaint(entry);
      }
    });
    container.addEventListener("mouseleave", () => {
      if (entry.hoverBlockId === null) return;
      entry.hoverBlockId = null;
      this.scheduleBlockPaint(entry);
    });

    this.terminals.set(id, entry);
    return entry;
  }

  private screenGeometry(entry: TerminalEntry) {
    const { term, container } = entry;
    const screen = container.querySelector(".xterm-screen") as HTMLElement | null;
    const rect = (screen ?? container).getBoundingClientRect();
    return {
      rect,
      cellW: rect.width / Math.max(1, term.cols),
      cellH: rect.height / Math.max(1, term.rows),
    };
  }

  private moveCursorToClick(entry: TerminalEntry, clientX: number, clientY: number) {
    const { term } = entry;
    const { rect, cellW, cellH } = this.screenGeometry(entry);
    const viewportRow = Math.floor((clientY - rect.top) / cellH);
    if (clientX < rect.left - cellW || viewportRow < 0 || viewportRow >= term.rows) return;
    const col = columnAtPixel(clientX, rect.left, cellW, term.cols);
    const targetRow = getBufferRowFromViewport(term, viewportRow);
    let anchor: { row: number; col: number } | undefined;
    if (entry.blocks.active) {
      // With shell integration the input start is exact; while a command is
      // running there is no input line to move in.
      const a = entry.blocks.inputAnchor(lineOfMarker);
      if (!a) return;
      anchor = a;
    }
    const clickBuffer = getClickBuffer(term);
    const segments = collectEditableSegments(clickBuffer, anchor);
    if (segments.length === 0) return;
    const firstRow = segments[0]?.row ?? 0;
    const lastRow = segments[segments.length - 1]?.row ?? 0;
    // Below the command (the empty rows under the prompt) means "the end".
    const row = targetRow > lastRow && anchor ? lastRow : targetRow;
    const atEnd = targetRow > lastRow && anchor !== undefined;
    if (row < firstRow || row > lastRow) return;
    const last = segments[segments.length - 1]!;
    const targetOffset = atEnd
      ? getSegmentOffset(segments, last.row, last.promptCols + last.editableCols)
      : getSegmentOffset(segments, row, col);
    const cursorOffset = getSegmentOffset(segments, clickBuffer.cursorRow, clickBuffer.cursorCol);
    if (targetOffset === null || cursorOffset === null) return;
    const presses = arrowPressesBetween(clickBuffer, segments, cursorOffset, targetOffset);
    if (presses === 0) return;
    const seq = (targetOffset > cursorOffset ? "\x1b[C" : "\x1b[D").repeat(presses);
    const sid = resolveInputTarget(entry);
    if (sid) {
      invoke("terminal_write", { sessionId: sid, data: seq }).catch(() => undefined);
    }
  }

  // ---------- command blocks ----------

  private setupBlocks(entry: TerminalEntry) {
    const { term, blockLayer } = entry;
    blockLayer.className = "term-blocks";
    blockLayer.hidden = true;
    entry.container.querySelector(".xterm-screen")?.appendChild(blockLayer);
    term.parser.registerOscHandler(133, (data) => {
      const mark = parseOsc133(data);
      const buf = term.buffer.active;
      if (!mark || buf.type === "alternate") return true;
      const marker = term.registerMarker(0);
      if (!marker) return true;
      entry.blocks.apply(mark, { at: marker, col: buf.cursorX }, Date.now());
      this.scheduleBlockPaint(entry);
      return true;
    });
    term.onRender(() => this.scheduleBlockPaint(entry));
    term.onScroll(() => this.scheduleBlockPaint(entry));
    term.buffer.onBufferChange(() => this.scheduleBlockPaint(entry));
  }

  private scheduleBlockPaint(entry: TerminalEntry) {
    if (entry.blockFrame !== null || !entry.blocks.active) return;
    entry.blockFrame = requestAnimationFrame(() => {
      entry.blockFrame = null;
      this.paintBlocks(entry);
    });
  }

  private paintBlocks(entry: TerminalEntry) {
    const { term, blocks, blockLayer } = entry;
    const buf = term.buffer.active;
    blocks.prune(lineOfMarker);
    if (!blocks.active || buf.type === "alternate") {
      blockLayer.hidden = true;
      return;
    }
    blockLayer.hidden = false;
    const cellH = blockLayer.clientHeight / Math.max(1, term.rows);
    const top = buf.viewportY;
    const bottom = top + term.rows;
    const ranges = blocks.ranges(lineOfMarker, buf.baseY + buf.cursorY + 1);
    const nodes: HTMLElement[] = [];
    ranges.forEach((r, i) => {
      if (r.end <= top || r.start >= bottom) return;
      const b = r.block;
      const el = document.createElement("div");
      const failed = b.state === "done" && b.exitCode !== null && b.exitCode !== 0;
      el.className = [
        "term-block",
        i === 0 ? "first" : "",
        b.state,
        failed ? "failed" : "",
        b.id === entry.selectedBlockId ? "selected" : "",
        b.id === entry.hoverBlockId && b.state === "done" ? "hover" : "",
      ]
        .filter(Boolean)
        .join(" ");
      el.style.top = `${(r.start - top) * cellH}px`;
      el.style.height = `${(r.end - r.start) * cellH}px`;
      const badge = b.state === "done" ? blockBadge(b) : null;
      if (badge) {
        const chip = document.createElement("span");
        chip.className = `term-block-badge${badge.failed ? " failed" : ""}`;
        chip.textContent = badge.text;
        el.appendChild(chip);
      }
      nodes.push(el);
    });
    blockLayer.replaceChildren(...nodes);
  }

  private blockAtClient(entry: TerminalEntry, clientY: number): Block<IMarker> | null {
    const { term, blocks } = entry;
    const buf = term.buffer.active;
    if (!blocks.active || buf.type === "alternate") return null;
    const { rect, cellH } = this.screenGeometry(entry);
    const viewportRow = Math.floor((clientY - rect.top) / cellH);
    if (viewportRow < 0 || viewportRow >= term.rows) return null;
    return blocks.blockAtLine(
      buf.viewportY + viewportRow,
      lineOfMarker,
      buf.baseY + buf.cursorY + 1,
    );
  }

  /** Block under a pointer position, for the context menu. */
  blockIdAt(termId: string, clientY: number): number | null {
    const entry = this.terminals.get(termId);
    if (!entry) return null;
    const b = this.blockAtClient(entry, clientY);
    return b && b.state === "done" ? b.id : null;
  }

  private selectBlock(entry: TerminalEntry, id: number | null) {
    if (entry.selectedBlockId === id) return;
    entry.selectedBlockId = id;
    if (id !== null) entry.term.clearSelection();
    this.scheduleBlockPaint(entry);
  }

  /** Select the previous/next finished block and scroll it into view. */
  private stepBlock(entry: TerminalEntry, dir: -1 | 1) {
    const done = entry.blocks.finished();
    if (done.length === 0) return;
    const idx = done.findIndex((b) => b.id === entry.selectedBlockId);
    let next: number;
    if (idx < 0) next = dir < 0 ? done.length - 1 : -1;
    else next = idx + dir;
    if (next < 0 || next >= done.length) {
      // Walking past the newest block returns to the prompt.
      if (dir > 0) {
        this.selectBlock(entry, null);
        entry.term.scrollToBottom();
      }
      return;
    }
    const b = done[next]!;
    this.selectBlock(entry, b.id);
    const line = lineOfMarker(b.prompt);
    const buf = entry.term.buffer.active;
    if (line >= 0 && (line < buf.viewportY || line >= buf.viewportY + entry.term.rows)) {
      entry.term.scrollToLine(Math.max(0, line - 1));
    }
  }

  private blockText(entry: TerminalEntry, b: Block<IMarker>, part: BlockPart): string {
    const buf = entry.term.buffer.active;
    const cols = entry.term.cols;
    const getRow = (row: number, startCol: number, endCol?: number) => {
      const line = buf.getLine(row);
      if (!line) return null;
      return { text: line.translateToString(false, startCol, endCol ?? cols), isWrapped: line.isWrapped };
    };
    const pos = (p: { at: IMarker; col: number } | null) =>
      p && !p.at.isDisposed ? { row: p.at.line, col: p.col } : null;
    const promptRow = lineOfMarker(b.prompt);
    const input = pos(b.input) ?? { row: promptRow, col: 0 };
    const output = pos(b.output);
    const end = pos(b.end) ?? { row: buf.baseY + buf.cursorY, col: 0 };
    const command = textBetween(getRow, input, output ?? end).trim();
    const out = output ? textBetween(getRow, output, end) : "";
    if (part === "command") return command;
    if (part === "output") return out;
    return out ? `${command}\n${out}` : command;
  }

  async copyBlock(termId: string, blockId: number, part: BlockPart): Promise<boolean> {
    const entry = this.terminals.get(termId);
    const b = entry?.blocks.blocks.find((x) => x.id === blockId);
    if (!entry || !b) return false;
    try {
      await navigator.clipboard.writeText(this.blockText(entry, b, part));
    } catch {
      return false;
    }
    entry.term.focus();
    return true;
  }

  /** Run a keyboard/context-menu action against a pane. */
  runAction(termId: string, action: TerminalKeyAction) {
    switch (action) {
      case "copy":
        void this.copySelection(termId);
        break;
      case "paste":
        void this.pasteClipboard(termId);
        break;
      case "selectAll":
        this.terminals.get(termId)?.term.selectAll();
        break;
      case "clear":
        this.clear(termId);
        break;
      case "find":
        this.openFind(termId);
        break;
      case "blockPrev":
      case "blockNext": {
        const entry = this.terminals.get(termId);
        if (entry) this.stepBlock(entry, action === "blockPrev" ? -1 : 1);
        break;
      }
    }
  }

  async copySelection(termId: string): Promise<boolean> {
    const entry = this.terminals.get(termId);
    if (!entry) return false;
    if (!entry.term.hasSelection()) {
      if (entry.selectedBlockId === null) return false;
      return this.copyBlock(termId, entry.selectedBlockId, "all");
    }
    const text = cleanCopiedText(entry.term.getSelection());
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    // Like Warp: copying ends the selection so the next click works normally.
    entry.term.clearSelection();
    entry.term.focus();
    return true;
  }

  async pasteClipboard(termId: string): Promise<void> {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    // term.paste() normalizes newlines and honors bracketed-paste mode.
    if (text) entry.term.paste(text);
    entry.term.focus();
  }

  /** Clear screen and scrollback, keeping the prompt line (Cmd+K). */
  clear(termId: string) {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    if (entry.term.buffer.active.type === "alternate") return;
    entry.term.clear();
    entry.search.clearDecorations();
    entry.selectedBlockId = null;
    this.scheduleBlockPaint(entry);
    entry.term.focus();
  }

  openFind(termId: string) {
    if (!this.terminals.has(termId)) return;
    if (this.findTermId && this.findTermId !== termId) {
      this.terminals.get(this.findTermId)?.search.clearDecorations();
    }
    this.findTermId = termId;
    const entry = this.terminals.get(termId)!;
    const selected = entry.term.getSelection();
    if (selected && !selected.includes("\n")) {
      this.search = { ...this.search, query: selected };
    }
    this.emit();
  }

  closeFind() {
    const id = this.findTermId;
    if (!id) return;
    const entry = this.terminals.get(id);
    entry?.search.clearDecorations();
    entry?.term.clearSelection();
    this.findTermId = null;
    this.search = { ...this.search, resultIndex: -1, resultCount: 0 };
    this.emit();
    this.focusLeaf(id);
  }

  findIn(
    termId: string,
    query: string,
    opts: { caseSensitive?: boolean; backwards?: boolean; incremental?: boolean } = {},
  ) {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    const caseSensitive = opts.caseSensitive ?? this.search.caseSensitive;
    this.search = { ...this.search, query, caseSensitive };
    if (!query) {
      entry.search.clearDecorations();
      entry.term.clearSelection();
      this.search = { ...this.search, resultIndex: -1, resultCount: 0 };
      this.emit();
      return;
    }
    const searchOpts = {
      caseSensitive,
      incremental: opts.incremental ?? false,
      decorations: SEARCH_DECORATIONS,
    };
    if (opts.backwards) entry.search.findPrevious(query, searchOpts);
    else entry.search.findNext(query, searchOpts);
    this.emit();
  }

  /** Start a fresh shell in a pane whose process exited. */
  async restart(termId: string): Promise<void> {
    const entry = this.terminals.get(termId);
    if (!entry || !entry.exited || entry.spawning) return;
    for (const u of entry.unlisten) {
      try {
        u();
      } catch {
        /* no-op */
      }
    }
    entry.unlisten = [];
    entry.sessionId = null;
    entry.spawned = false;
    entry.outputSeen = false;
    entry.exited = false;
    entry.initialPassphrase = null;
    entry.selectedBlockId = null;
    // Soft reset (DECSTR): drops modes the dead process left on (mouse
    // tracking, hidden cursor, app keypad) but keeps its output readable.
    entry.term.write("\x1b[!p\r\n");
    this.emit();
    await this.spawn(entry);
    this.focusLeaf(termId);
  }

  private async spawn(entry: TerminalEntry): Promise<void> {
    if (entry.spawning || entry.sessionId) return;
    entry.spawning = true;
    try {
      const cols = entry.term.cols || 80;
      const rows = entry.term.rows || 24;

      // Clear any bracketed-paste mode left latched by a previous process in
      // this terminal. The flag lives in xterm's parser, not in the shell, so a
      // process that sent ESC[?2004h and died without the matching ESC[?2004l
      // keeps it on: later pastes get wrapped in ESC[200~/ESC[201~ and the new
      // shell prints them literally. Written into the emulator, not the PTY.
      entry.term.write("\x1b[?2004l");

      // Subscribe before spawning. The backend starts reading the PTY as soon
      // as the shell exists, so registering listeners on the id it returned
      // dropped whatever the shell emitted in between — losing the opening
      // prompt or the redraw that follows a signal. Generating the id here
      // lets the listeners exist first.
      const sessionId = cryptoRandomUuid();
      entry.sessionId = sessionId;
      entry.spawned = false;
      entry.outputSeen = false;
      const dataEvt = `terminal:data:${sessionId}`;
      const exitEvt = `terminal:exit:${sessionId}`;
      const u1 = await listen<string>(dataEvt, (e) => {
        if (entry.sessionId !== sessionId) return;
        entry.outputSeen = true;
        entry.lastWriteAt = Date.now();
        entry.term.write(decodeBase64(e.payload));
      });
      const u2 = await listen<void>(exitEvt, () => {
        if (entry.sessionId !== sessionId) return;
        entry.term.write(
          "\r\n\x1b[2m── process exited · press Enter to restart ──\x1b[0m\r\n",
        );
        entry.exited = true;
        this.emit();
      });
      entry.unlisten.push(u1, u2);

      try {
        await invoke<string>("terminal_spawn", {
          name: entry.name,
          project: entry.project,
          passphrase: entry.initialPassphrase ?? null,
          cwd: entry.cwd,
          cols,
          rows,
          shell: entry.shell ?? "auto",
          sessionId,
        });
      } catch (err) {
        // Spawn failed, so nothing will ever emit on these events.
        u1();
        u2();
        entry.unlisten = entry.unlisten.filter((u) => u !== u1 && u !== u2);
        entry.sessionId = null;
        throw err;
      }

      entry.spawned = true;
      entry.initialPassphrase = null;
      // Record what the PTY was created with so the first resize only fires if
      // the layout actually differs from the spawn geometry.
      entry.ptyCols = cols;
      entry.ptyRows = rows;
      // The layout may have settled while the shell was starting; push the
      // real geometry now instead of waiting for the next ResizeObserver tick.
      this.resizeLeaf(entry.id);
    } catch (err) {
      entry.term.write(
        `\r\n\x1b[31m[failed to start shell: ${String(err)}]\x1b[0m\r\n\x1b[2mpress Enter to retry\x1b[0m\r\n`,
      );
      entry.exited = true;
    } finally {
      entry.spawning = false;
      this.emit();
    }
  }

  private async disposeTerminal(termId: string): Promise<void> {
    const entry = this.terminals.get(termId);
    if (!entry) return;
    if (entry.resizeFrame !== null) {
      cancelAnimationFrame(entry.resizeFrame);
      entry.resizeFrame = null;
    }
    if (entry.clickTimer !== null) {
      window.clearTimeout(entry.clickTimer);
      entry.clickTimer = null;
    }
    if (entry.blockFrame !== null) {
      cancelAnimationFrame(entry.blockFrame);
      entry.blockFrame = null;
    }
    entry.blocks.clear();
    if (entry.pendingFocus) {
      entry.pendingFocus();
      entry.pendingFocus = null;
    }
    if (this.findTermId === termId) this.findTermId = null;
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
    // Coalesce resizes into one per frame. A ResizeObserver fires several times
    // while a split or the dock settles, and every fit() that reaches the PTY
    // raises SIGWINCH — a burst of them makes a full-screen program redraw at
    // several widths in a row, which is what leaves torn, overlapping rows.
    if (entry.resizeFrame !== null) {
      cancelAnimationFrame(entry.resizeFrame);
    }
    entry.resizeFrame = requestAnimationFrame(() => {
      entry.resizeFrame = null;
      this.applyResize(entry);
    });
  }

  private applyResize(entry: TerminalEntry) {
    try {
      entry.fit.fit();
    } catch {
      /* no-op */
    }
    const { cols, rows } = entry.term;
    if (!entry.sessionId || !entry.spawned || entry.exited) return;
    if (
      !shouldResizePty({
        cols,
        rows,
        ptyCols: entry.ptyCols,
        ptyRows: entry.ptyRows,
      })
    ) {
      return;
    }
    entry.ptyCols = cols;
    entry.ptyRows = rows;
    invoke("terminal_resize", {
      sessionId: entry.sessionId,
      cols,
      rows,
    }).catch(() => undefined);
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

    // xterm's textarea only takes focus once the terminal has been laid out.
    // On the very first terminal the call lands before the container has a
    // size, so it silently does nothing and the pane looks inert until the
    // user clicks or opens another tab.
    //
    // Waiting a fixed number of frames is not enough: on a cold start the
    // webview can take arbitrarily long to lay out, and once the retries run
    // out the pane stays dead. Observe the container instead and focus on the
    // first measurement that has a real size.
    if (entry.pendingFocus) {
      entry.pendingFocus();
      entry.pendingFocus = null;
    }

    const tryFocus = (): boolean => {
      if (!entry.container.isConnected) return false;
      const { clientWidth, clientHeight } = entry.container;
      if (clientWidth <= 0 || clientHeight <= 0) return false;
      try {
        entry.term.focus();
      } catch {
        return false;
      }
      return true;
    };

    if (tryFocus()) return;

    const ro = new ResizeObserver(() => {
      if (tryFocus()) {
        ro.disconnect();
        entry.pendingFocus = null;
      }
    });
    ro.observe(entry.container);
    entry.pendingFocus = () => ro.disconnect();
  }

  /**
   * Clear input modes left latched by a process that exited without restoring
   * them — most visibly bracketed paste (ESC[?2004h), which makes every later
   * paste come through wrapped in ESC[200~/ESC[201~ that the shell prints
   * literally. spawn() already does this for new sessions; this covers a
   * session that got stuck while open, so the user need not open a new tab.
   *
   * Writes into the emulator rather than the PTY: these modes live in xterm's
   * parser, not in the shell.
   */
  resetInputModes(termId?: string) {
    const id = termId ?? this.getActiveTab()?.activeLeaf;
    if (!id) return;
    const entry = this.terminals.get(id);
    if (!entry) return;
    // Bracketed paste, application cursor keys, application keypad.
    entry.term.write("\x1b[?2004l\x1b[?1l\x1b>");
    this.focusLeaf(id);
  }

  /** Cycle pane focus within the active tab. delta: +1 next, -1 previous. */
  focusRelativeLeaf(delta: number) {
    const tab = this.getActiveTab();
    if (!tab) return;
    const leaves = collectLeaves(tab.layout);
    if (leaves.length < 2) return;
    const idx = leaves.findIndex((l) => l.termId === tab.activeLeaf);
    const next = leaves[(idx + delta + leaves.length) % leaves.length];
    tab.activeLeaf = next.termId;
    this.emit();
    this.focusLeaf(next.termId);
  }

  /** Cycle between terminal tabs. delta: +1 next, -1 previous. */
  focusRelativeTab(delta: number) {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex((t) => t.id === this.activeTabId);
    const next = this.tabs[(idx + delta + this.tabs.length) % this.tabs.length];
    this.activeTabId = next.id;
    this.emit();
    this.focusLeaf(next.activeLeaf);
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function cryptoRandom(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A real UUID, unlike `cryptoRandom`'s fallback. The backend rejects a session
 * id that doesn't parse as one, so this is used for ids that cross the IPC
 * boundary rather than for local element keys.
 */
function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 layout, filled from getRandomValues when available.
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
