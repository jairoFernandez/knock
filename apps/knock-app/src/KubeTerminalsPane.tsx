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

interface PaneViewProps {
  pane: Pane;
  tabId: string;
  path: number[];
  activeLeaf: string;
}

function LeafView({
  termId,
  tabId,
  isActive,
}: {
  termId: string;
  tabId: string;
  isActive: boolean;
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
      className={`kube-leaf ${isActive ? "active" : ""}`}
      style={{ "--leaf-color": entry.color } as React.CSSProperties}
      onMouseDown={() => terminalStore.setLeafActive(tabId, termId)}
    >
      <LeafHeader entry={entry} tabId={tabId} />
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
          title="Split right"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.setLeafActive(tabId, entry.id);
            terminalStore.splitActive("h");
          }}
        >
          Split →
        </button>
        <button
          title="Split down"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.setLeafActive(tabId, entry.id);
            terminalStore.splitActive("v");
          }}
        >
          Split ↓
        </button>
        <button
          title="Close pane"
          onClick={(e) => {
            e.stopPropagation();
            terminalStore.closeLeaf(tabId, entry.id);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function PaneView({ pane, tabId, path, activeLeaf }: PaneViewProps) {
  if (pane.kind === "leaf") {
    return (
      <LeafView termId={pane.termId} tabId={tabId} isActive={pane.termId === activeLeaf} />
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
        />
      }
      b={
        <PaneView
          pane={pane.b}
          tabId={tabId}
          path={[...path, 1]}
          activeLeaf={activeLeaf}
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
  onTabCreated?: () => void;
  onTabSelected?: () => void;
}

export function KubeTerminalsPane({
  spawnArgs,
  bodyCollapsed = false,
  toolbar,
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
        {tabs.map((tab) => {
          const leaves = collectLeaves(tab.layout);
          const colors = leaves
            .map((l) => terminalStore.terminals.get(l.termId)?.color)
            .filter(Boolean) as string[];
          return (
            <button
              key={tab.id}
              className={`kube-terms-tab ${tab.id === activeTabId ? "active" : ""}`}
              onClick={() => {
                terminalStore.setActiveTab(tab.id);
                onTabSelected?.();
              }}
              title={tab.label}
            >
              <span className="kube-terms-tab-colors">
                {colors.slice(0, 4).map((c, i) => (
                  <span key={i} className="kube-terms-tab-dot" style={{ background: c }} />
                ))}
              </span>
              <span className="kube-terms-tab-label">{tab.label}</span>
              <span className="kube-terms-tab-count">{leaves.length}</span>
              <span
                className="kube-terms-tab-close"
                role="button"
                title="Close terminal tab"
                onClick={(e) => {
                  e.stopPropagation();
                  terminalStore.closeTab(tab.id);
                }}
              >
                ×
              </span>
            </button>
          );
        })}
        <button
          className="kube-terms-new"
          onClick={newTab}
          title={
            spawnArgs
              ? `New terminal for ${spawnArgs.project}/${spawnArgs.name}`
              : "New plain shell"
          }
        >
          + Shell
        </button>
        {toolbar}
      </div>
      {!bodyCollapsed && <div className="kube-terms-body">
        {!activeTab && (
          <div className="kube-empty">
            No terminals. Click <strong>+ Shell</strong> to start one
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
