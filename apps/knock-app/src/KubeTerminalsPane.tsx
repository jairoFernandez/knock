import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  terminalStore,
  collectLeaves,
  shortcutLabel,
  SESSION_COLORS,
  type Pane,
  type KubeTerminalSpawnArgs,
  type TerminalEntry,
} from "./kubeTerminalStore";
import { clampMenuPosition } from "./terminalInput";
import { TermIcon } from "./terminalIcons";

function useStoreSnapshot(): number {
  return useSyncExternalStore(
    (cb) => terminalStore.subscribe(cb),
    () => terminalStore.revision,
    () => terminalStore.revision,
  );
}

interface PaneViewProps {
  pane: Pane;
  tabId: string;
  path: number[];
  activeLeaf: string;
  /** True when the tab holds more than one leaf (splits). */
  multi: boolean;
}

function LeafView({
  termId,
  tabId,
  isActive,
  multi,
}: {
  termId: string;
  tabId: string;
  isActive: boolean;
  multi: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const entry = terminalStore.terminals.get(termId);
  const [menu, setMenu] = useState<{ x: number; y: number; blockId: number | null } | null>(
    null,
  );

  // Attach the persistent xterm container DOM element here. React never
  // owns the xterm DOM — just the wrapper.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !entry) return;
    if (entry.container.parentElement !== host) {
      host.appendChild(entry.container);
    }
    // Resize after layout settles
    const ro = new ResizeObserver(() => terminalStore.resizeLeaf(termId));
    ro.observe(host);
    requestAnimationFrame(() => terminalStore.resizeLeaf(termId));
    return () => {
      ro.disconnect();
    };
  }, [termId, entry]);

  // Also runs on mount, which is what makes the very first terminal usable
  // without opening a second tab first: that leaf is already active on the
  // initial render, so an isActive transition never happens for it.
  useEffect(() => {
    if (isActive) terminalStore.focusLeaf(termId);
  }, [isActive, termId, entry]);

  if (!entry) {
    return <div className="kube-leaf kube-leaf-missing">(missing terminal)</div>;
  }

  const findOpen = terminalStore.findTermId === termId;

  return (
    <div
      className={`kube-leaf ${isActive ? "active" : ""} ${multi ? "multi" : ""} ${
        entry.exited ? "exited" : ""
      }`}
      style={{ "--leaf-color": entry.color } as React.CSSProperties}
      // Focus on every mousedown, not only when the active leaf changes:
      // clicking an already-active pane after focus drifted elsewhere (a tab
      // button, the splitter) must send keys — including Ctrl-C — back to the
      // PTY rather than to the window.
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(".term-find, .kube-leaf-header")) return;
        terminalStore.setLeafActive(tabId, termId);
        terminalStore.focusLeaf(termId);
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest(".term-find, .kube-leaf-header input")) return;
        e.preventDefault();
        terminalStore.setLeafActive(tabId, termId);
        setMenu({ x: e.clientX, y: e.clientY, blockId: terminalStore.blockIdAt(termId, e.clientY) });
      }}
    >
      {multi && <LeafHeader entry={entry} tabId={tabId} />}
      <div className="kube-leaf-body">
        <div ref={hostRef} className="kube-leaf-host" />
        {findOpen && <FindBar termId={termId} />}
      </div>
      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          blockId={menu.blockId}
          entry={entry}
          tabId={tabId}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function FindBar({ termId }: { termId: string }) {
  useStoreSnapshot();
  const inputRef = useRef<HTMLInputElement>(null);
  const { query, caseSensitive, resultIndex, resultCount } = terminalStore.search;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    if (query) terminalStore.findIn(termId, query, { incremental: true });
    // Run once when the bar opens for this pane.
  }, [termId]);

  const status = !query
    ? ""
    : resultCount === 0
      ? "No results"
      : resultIndex >= 0
        ? `${resultIndex + 1} of ${resultCount}`
        : `${resultCount} found`;

  return (
    <div className="term-find" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <TermIcon name="search" size={13} />
      <input
        ref={inputRef}
        className="term-find-input"
        placeholder="Find"
        value={query}
        spellCheck={false}
        onChange={(e) =>
          terminalStore.findIn(termId, e.target.value, { incremental: true })
        }
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            terminalStore.findIn(termId, query, { backwards: e.shiftKey });
          } else if (e.key === "Escape") {
            e.preventDefault();
            terminalStore.closeFind();
          }
        }}
      />
      <span className={`term-find-count ${query && resultCount === 0 ? "none" : ""}`}>
        {status}
      </span>
      <button
        className={`term-find-btn term-find-case ${caseSensitive ? "on" : ""}`}
        title="Match case"
        aria-pressed={caseSensitive}
        onClick={() =>
          terminalStore.findIn(termId, query, { caseSensitive: !caseSensitive, incremental: true })
        }
      >
        Aa
      </button>
      <button
        className="term-find-btn"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        onClick={() => terminalStore.findIn(termId, query, { backwards: true })}
      >
        <TermIcon name="arrowUp" size={13} />
      </button>
      <button
        className="term-find-btn"
        title="Next match (Enter)"
        aria-label="Next match"
        onClick={() => terminalStore.findIn(termId, query)}
      >
        <TermIcon name="arrowDown" size={13} />
      </button>
      <button
        className="term-find-btn"
        title="Close (Esc)"
        aria-label="Close find"
        onClick={() => terminalStore.closeFind()}
      >
        <TermIcon name="close" size={13} />
      </button>
    </div>
  );
}

type MenuItem =
  | { kind: "sep" }
  | {
      kind: "item";
      label: string;
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      run: () => void;
    };

function TerminalContextMenu({
  x,
  y,
  blockId,
  entry,
  tabId,
  onClose,
}: {
  x: number;
  y: number;
  blockId: number | null;
  entry: TerminalEntry;
  tabId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const hasSelection = entry.term.hasSelection();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        x,
        y,
        { width: r.width, height: r.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [x, y]);

  useEffect(() => {
    function onDown(ev: MouseEvent) {
      if (ref.current?.contains(ev.target as Node)) return;
      onClose();
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const id = entry.id;
  const blockItems: MenuItem[] =
    blockId === null
      ? []
      : [
          {
            kind: "item",
            label: "Copy command",
            run: () => void terminalStore.copyBlock(id, blockId, "command"),
          },
          {
            kind: "item",
            label: "Copy output",
            run: () => void terminalStore.copyBlock(id, blockId, "output"),
          },
          {
            kind: "item",
            label: "Copy command and output",
            run: () => void terminalStore.copyBlock(id, blockId, "all"),
          },
          { kind: "sep" },
        ];
  const items: MenuItem[] = [
    ...blockItems,
    {
      kind: "item",
      label: "Copy",
      hint: shortcutLabel("c", { shift: !isMacLike() }),
      disabled: !hasSelection,
      run: () => void terminalStore.copySelection(id),
    },
    {
      kind: "item",
      label: "Paste",
      hint: shortcutLabel("v", { shift: !isMacLike() }),
      run: () => void terminalStore.pasteClipboard(id),
    },
    {
      kind: "item",
      label: "Select all",
      hint: shortcutLabel("a", { shift: !isMacLike() }),
      run: () => terminalStore.runAction(id, "selectAll"),
    },
    { kind: "sep" },
    {
      kind: "item",
      label: "Find…",
      hint: shortcutLabel("f", { shift: !isMacLike() }),
      run: () => terminalStore.openFind(id),
    },
    {
      kind: "item",
      label: "Clear",
      hint: shortcutLabel("k", { shift: !isMacLike() }),
      run: () => terminalStore.clear(id),
    },
    { kind: "sep" },
    {
      kind: "item",
      label: "Split right",
      hint: shortcutLabel("d", { shift: true }),
      run: () => void terminalStore.splitActive("h"),
    },
    {
      kind: "item",
      label: "Split down",
      hint: shortcutLabel("e", { shift: true }),
      run: () => void terminalStore.splitActive("v"),
    },
    ...(entry.exited
      ? [
          {
            kind: "item" as const,
            label: "Restart shell",
            hint: "Enter",
            run: () => void terminalStore.restart(id),
          },
        ]
      : []),
    {
      kind: "item",
      label: "Reset input modes",
      hint: shortcutLabel("r", { shift: true }),
      run: () => terminalStore.resetInputModes(id),
    },
    { kind: "sep" },
    {
      kind: "item",
      label: "Close pane",
      danger: true,
      run: () => void terminalStore.closeLeaf(tabId, id),
    },
  ];

  return createPortal(
    <div
      ref={ref}
      className="term-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.kind === "sep" ? (
          <div key={`sep-${i}`} className="term-menu-sep" role="separator" />
        ) : (
          <button
            key={it.label}
            role="menuitem"
            className={`term-menu-item ${it.danger ? "danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span>{it.label}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

function isMacLike(): boolean {
  return shortcutLabel("x").startsWith("⌘");
}

function LeafHeader({ entry, tabId }: { entry: TerminalEntry; tabId: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.title);
  const [showColors, setShowColors] = useState(false);

  function commit() {
    const v = draft.trim();
    if (v) terminalStore.setTerminalTitle(entry.id, v);
    setEditing(false);
  }

  return (
    <div
      className="kube-leaf-header"
      onMouseDown={() => terminalStore.setLeafActive(tabId, entry.id)}
    >
      <button
        className="kube-leaf-dot"
        style={{ background: entry.color }}
        title="Change color"
        aria-label="Change color"
        onClick={(e) => {
          e.stopPropagation();
          setShowColors((v) => !v);
        }}
      />
      {showColors && (
        <div className="kube-color-pop" onMouseDown={(e) => e.stopPropagation()}>
          {SESSION_COLORS.map((c) => (
            <button
              key={c}
              className={`kube-color-swatch ${c === entry.color ? "selected" : ""}`}
              style={{ background: c }}
              aria-label={`Color ${c}`}
              onClick={() => {
                terminalStore.setTerminalColor(entry.id, c);
                setShowColors(false);
              }}
            />
          ))}
        </div>
      )}
      {editing ? (
        <input
          className="kube-leaf-title-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") {
              setDraft(entry.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="kube-leaf-title"
          title="Double-click to rename"
          onDoubleClick={() => {
            setDraft(entry.title);
            setEditing(true);
          }}
        >
          {entry.title}
        </span>
      )}
      <span className="kube-leaf-tag">
        {entry.name ? `${entry.project}/${entry.name}` : entry.cwd || "shell"}
      </span>
      {entry.exited && <span className="kube-leaf-badge">exited</span>}
      <div className="kube-leaf-actions">
        <button
          className="kube-leaf-action"
          title={`Split right (${shortcutLabel("d", { shift: true })})`}
          aria-label="Split right"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.setLeafActive(tabId, entry.id);
            void terminalStore.splitActive("h");
          }}
        >
          <TermIcon name="splitRight" size={13} />
        </button>
        <button
          className="kube-leaf-action"
          title={`Split down (${shortcutLabel("e", { shift: true })})`}
          aria-label="Split down"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.setLeafActive(tabId, entry.id);
            void terminalStore.splitActive("v");
          }}
        >
          <TermIcon name="splitDown" size={13} />
        </button>
        <button
          className="kube-leaf-action danger"
          title="Close pane"
          aria-label="Close pane"
          onClick={(e) => {
            e.stopPropagation();
            void terminalStore.closeLeaf(tabId, entry.id);
          }}
        >
          <TermIcon name="close" size={13} />
        </button>
      </div>
    </div>
  );
}

function PaneView({ pane, tabId, path, activeLeaf, multi }: PaneViewProps) {
  if (pane.kind === "leaf") {
    return (
      <LeafView
        termId={pane.termId}
        tabId={tabId}
        isActive={pane.termId === activeLeaf}
        multi={multi}
      />
    );
  }
  const isH = pane.orientation === "h";
  return (
    <SplitView
      orientation={pane.orientation}
      ratio={pane.ratio}
      onRatio={(r) => terminalStore.setSplitRatio(tabId, path, r)}
      a={
        <PaneView
          pane={pane.a}
          tabId={tabId}
          path={[...path, 0]}
          activeLeaf={activeLeaf}
          multi={multi}
        />
      }
      b={
        <PaneView
          pane={pane.b}
          tabId={tabId}
          path={[...path, 1]}
          activeLeaf={activeLeaf}
          multi={multi}
        />
      }
      isH={isH}
    />
  );
}

function SplitView({
  orientation,
  ratio,
  onRatio,
  a,
  b,
  isH,
}: {
  orientation: "h" | "v";
  ratio: number;
  onRatio: (r: number) => void;
  a: React.ReactNode;
  b: React.ReactNode;
  isH: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    dragging.current = true;
    const move = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pos = isH ? ev.clientX - rect.left : ev.clientY - rect.top;
      const total = isH ? rect.width : rect.height;
      if (total <= 0) return;
      onRatio(pos / total);
    };
    const up = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const aSize = `${(ratio * 100).toFixed(2)}%`;
  const bSize = `${((1 - ratio) * 100).toFixed(2)}%`;

  return (
    <div
      ref={containerRef}
      className={`kube-split ${orientation === "h" ? "h" : "v"}`}
    >
      <div className="kube-split-pane" style={{ flexBasis: aSize }}>
        {a}
      </div>
      <div
        className={`kube-split-handle ${orientation === "h" ? "h" : "v"}`}
        onMouseDown={onMouseDown}
        title="Drag to resize"
      />
      <div className="kube-split-pane" style={{ flexBasis: bSize }}>
        {b}
      </div>
    </div>
  );
}

interface Props {
  spawnArgs: KubeTerminalSpawnArgs | null;
  bodyCollapsed?: boolean;
  toolbar?: React.ReactNode;
  hideNewButton?: boolean;
  onTabCreated?: () => void;
  onTabSelected?: () => void;
}

function TabButton({
  tab,
  active,
  onSelect,
}: {
  tab: { id: string; label: string; layout: Pane };
  active: boolean;
  onSelect: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tab.label);
  const leaves = collectLeaves(tab.layout);
  const multi = leaves.length > 1;
  const colors = leaves
    .map((l) => terminalStore.terminals.get(l.termId)?.color)
    .filter(Boolean) as string[];

  function commit() {
    const v = draft.trim();
    if (v) terminalStore.renameTab(tab.id, v);
    setEditing(false);
  }

  return (
    <button
      className={`kube-terms-tab ${active ? "active" : ""}`}
      onClick={onSelect}
      onDoubleClick={() => {
        setDraft(tab.label);
        setEditing(true);
      }}
      title={editing ? undefined : `${tab.label} — double-click to rename`}
    >
      <span className="kube-terms-tab-colors">
        {(multi ? colors.slice(0, 3) : colors.slice(0, 1)).map((c, i) => (
          <span key={i} className="kube-terms-tab-dot" style={{ background: c }} />
        ))}
      </span>
      {editing ? (
        <input
          className="kube-terms-tab-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span className="kube-terms-tab-label">{tab.label}</span>
      )}
      {multi && <span className="kube-terms-tab-count">{leaves.length}</span>}
      <span
        className="kube-terms-tab-close"
        role="button"
        tabIndex={0}
        title="Close terminal tab"
        aria-label="Close terminal tab"
        onClick={(e) => {
          e.stopPropagation();
          terminalStore.closeTab(tab.id);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            terminalStore.closeTab(tab.id);
          }
        }}
      >
        <TermIcon name="close" size={12} />
      </span>
    </button>
  );
}

export function KubeTerminalsPane({
  spawnArgs,
  bodyCollapsed = false,
  toolbar,
  hideNewButton = false,
  onTabCreated,
  onTabSelected,
}: Props) {
  useStoreSnapshot();
  const tabs = terminalStore.tabs;
  const activeTabId = terminalStore.activeTabId;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  async function newTab() {
    if (spawnArgs) {
      await terminalStore.openNewTab(spawnArgs);
    } else {
      await terminalStore.openGeneralTab();
    }
    onTabCreated?.();
  }

  return (
    <div className="kube-terms">
      <div className="kube-terms-tabs">
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => {
              terminalStore.setActiveTab(tab.id);
              onTabSelected?.();
            }}
          />
        ))}
        {!hideNewButton && (
          <button
            className="kube-terms-new"
            onClick={newTab}
            title={
              spawnArgs
                ? `New terminal for ${spawnArgs.project}/${spawnArgs.name}`
                : "New plain shell"
            }
          >
            <TermIcon name="plus" size={13} />
            <span>Shell</span>
          </button>
        )}
        {toolbar}
      </div>
      {!bodyCollapsed && <div className="kube-terms-body">
        {!activeTab && (
          <div className="kube-empty">
            No terminals. Create a <strong>new shell</strong> to start one
            {spawnArgs ? ` for ${spawnArgs.project}/${spawnArgs.name}` : ""}.
          </div>
        )}
        {activeTab && (
          <PaneView
            key={activeTab.id}
            pane={activeTab.layout}
            tabId={activeTab.id}
            path={[]}
            activeLeaf={activeTab.activeLeaf}
            multi={collectLeaves(activeTab.layout).length > 1}
          />
        )}
      </div>}
    </div>
  );
}

