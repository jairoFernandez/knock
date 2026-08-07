import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  terminalStore,
  SESSION_COLORS,
  type Pane,
  type KubeTerminalSpawnArgs,
  type TerminalEntry,
} from "./kubeTerminalStore";

function useStoreSnapshot(): number {
  return useSyncExternalStore(
    (cb) => terminalStore.subscribe(cb),
    () => terminalStore.revision,
    () => terminalStore.revision,
  );
}

function ShellControlIcon({
  children,
  size = 14,
}: {
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <svg
      className="shell-control-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
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

  useEffect(() => {
    if (isActive) terminalStore.focusLeaf(termId);
  }, [isActive, termId]);

  if (!entry) {
    return <div className="kube-leaf kube-leaf-missing">(missing terminal)</div>;
  }

  return (
    <div
      className={`kube-leaf ${isActive ? "active" : ""} ${multi ? "multi" : ""}`}
      style={{ "--leaf-color": entry.color } as React.CSSProperties}
      onMouseDown={() => terminalStore.setLeafActive(tabId, termId)}
    >
      {multi && <LeafHeader entry={entry} tabId={tabId} />}
      <div ref={hostRef} className="kube-leaf-host" />
    </div>
  );
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
    <div className="kube-leaf-header">
      <span
        className="kube-leaf-dot"
        style={{ background: entry.color }}
        title="Change color"
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
        {entry.exited && " · exited"}
      </span>
      <div className="kube-leaf-actions">
        <button
          className="kube-leaf-action"
          title="Split right"
          aria-label="Split right"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.setLeafActive(tabId, entry.id);
            terminalStore.splitActive("h");
          }}
        >
          <ShellControlIcon>
            <path d="M2.5 3.5h11" />
            <path d="M2.5 8h11" />
            <path d="M2.5 12.5h11" />
            <path d="M8 2.5v11" opacity="0.45" />
            <path d="M10 8h3.5" />
            <path d="M11.8 6.2 13.5 8l-1.7 1.8" />
          </ShellControlIcon>
        </button>
        <button
          className="kube-leaf-action"
          title="Split down"
          aria-label="Split down"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.setLeafActive(tabId, entry.id);
            terminalStore.splitActive("v");
          }}
        >
          <ShellControlIcon>
            <path d="M3.5 2.5v11" />
            <path d="M8 2.5v11" />
            <path d="M12.5 2.5v11" />
            <path d="M2.5 8h11" opacity="0.45" />
            <path d="M8 10v3.5" />
            <path d="M6.2 11.8 8 13.5l1.8-1.7" />
          </ShellControlIcon>
        </button>
        <button
          className="kube-leaf-action danger"
          title="Close pane"
          aria-label="Close pane"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.closeLeaf(tabId, entry.id);
          }}
        >
          <ShellControlIcon>
            <path d="M4.5 4.5l7 7" />
            <path d="M11.5 4.5l-7 7" />
          </ShellControlIcon>
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
        <ShellControlIcon size={11}>
          <path d="M4.5 4.5l7 7" />
          <path d="M11.5 4.5l-7 7" />
        </ShellControlIcon>
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
            <ShellControlIcon size={13}>
              <path d="M8 3v10" />
              <path d="M3 8h10" />
            </ShellControlIcon>
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

function collectLeaves(p: Pane): { kind: "leaf"; termId: string }[] {
  if (p.kind === "leaf") return [p];
  return [...collectLeaves(p.a), ...collectLeaves(p.b)];
}
