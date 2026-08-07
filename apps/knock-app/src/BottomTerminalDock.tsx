import { useEffect, useRef, useState } from "react";
import { useColumnDrag } from "./hooks";
import { KubeTerminalsPane } from "./KubeTerminalsPane";
import {
  listShells,
  terminalStore,
  type KubeTerminalSpawnArgs,
  type ShellInfo,
} from "./kubeTerminalStore";

interface Props {
  spawnArgs: KubeTerminalSpawnArgs | null;
  expanded: boolean;
  maximized: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onMaximizedChange: (maximized: boolean) => void;
  onHeightDelta: (delta: number) => void;
}

function DockIcon({
  children,
  size = 14,
}: {
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <svg
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

export function BottomTerminalDock({
  spawnArgs,
  expanded,
  maximized,
  onExpandedChange,
  onMaximizedChange,
  onHeightDelta,
}: Props) {
  const startResize = useColumnDrag({
    axis: "y",
    onDelta: (delta) => onHeightDelta(-delta),
  });

  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listShells().then(setShells);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(ev: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  async function openNewShell(shell?: string) {
    if (spawnArgs) {
      await terminalStore.openNewTab({ ...spawnArgs, shell: shell ?? spawnArgs.shell ?? null });
    } else {
      await terminalStore.openGeneralTab({ shell: shell ?? null });
    }
    onExpandedChange(true);
  }

  // Only offer the picker when there's more than the default + at least one
  // concrete shell is detected.
  const pickable = shells.filter((s) => s.id !== "auto" && s.available);

  return (
    <section
      className={`bottom-terminal-dock ${expanded ? "expanded" : "collapsed"} ${
        maximized ? "maximized" : ""
      }`}
    >
      {expanded && !maximized && (
        <div
          className="bottom-terminal-resizer"
          onMouseDown={startResize}
          title="Resize terminal"
        />
      )}
      <KubeTerminalsPane
        spawnArgs={spawnArgs}
        bodyCollapsed={!expanded}
        hideNewButton
        onTabCreated={() => onExpandedChange(true)}
        onTabSelected={() => onExpandedChange(true)}
        toolbar={
          <div className="bottom-terminal-actions">
            <div className="bottom-terminal-new-group" ref={menuRef}>
              <button
                className="bottom-terminal-new"
                title={`${
                  spawnArgs
                    ? `New terminal for ${spawnArgs.project}/${spawnArgs.name}`
                    : "New plain shell"
                } (Ctrl/Cmd+Shift+T)`}
                onClick={() => {
                  void openNewShell();
                }}
              >
                <DockIcon size={13}>
                  <path d="M8 3v10" />
                  <path d="M3 8h10" />
                </DockIcon>
                <span>Shell</span>
              </button>
              {pickable.length > 0 && (
                <button
                  className="bottom-terminal-new-caret"
                  title="Choose shell"
                  aria-label="Choose shell"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((o) => !o)}
                >
                  <DockIcon size={11}>
                    <path d="M4 6.5 8 10l4-3.5" />
                  </DockIcon>
                </button>
              )}
              {menuOpen && pickable.length > 0 && (
                <div className="bottom-terminal-shell-menu" role="menu">
                  {pickable.map((s) => (
                    <button
                      key={s.id}
                      role="menuitem"
                      className="bottom-terminal-shell-item"
                      onClick={() => {
                        setMenuOpen(false);
                        void openNewShell(s.id);
                      }}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {terminalStore.tabs.length > 0 && (
              <>
                <button
                  className="bottom-terminal-icon"
                  title="Split right (Ctrl/Cmd+Shift+D)"
                  aria-label="Split right"
                  onClick={() => {
                    void terminalStore.splitActive("h");
                    onExpandedChange(true);
                  }}
                >
                  <DockIcon size={13}>
                    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
                    <path d="M8 3v10" />
                  </DockIcon>
                </button>
                <button
                  className="bottom-terminal-icon"
                  title="Split down (Ctrl/Cmd+Shift+E)"
                  aria-label="Split down"
                  onClick={() => {
                    void terminalStore.splitActive("v");
                    onExpandedChange(true);
                  }}
                >
                  <DockIcon size={13}>
                    <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
                    <path d="M2.5 8h11" />
                  </DockIcon>
                </button>
              </>
            )}
            <button
              className="bottom-terminal-icon"
              title={expanded ? "Collapse terminal" : "Open terminal"}
              aria-label={expanded ? "Collapse terminal" : "Open terminal"}
              onClick={() => onExpandedChange(!expanded)}
            >
              <DockIcon>
                {expanded ? <path d="M4 6.5 8 10l4-3.5" /> : <path d="M4 9.5 8 6l4 3.5" />}
              </DockIcon>
            </button>
            <button
              className="bottom-terminal-icon"
              title={maximized ? "Restore terminal" : "Maximize terminal"}
              aria-label={maximized ? "Restore terminal" : "Maximize terminal"}
              onClick={() => {
                onMaximizedChange(!maximized);
                onExpandedChange(true);
              }}
            >
              <DockIcon>
                {maximized ? (
                  <>
                    <path d="M6.5 3.5H3.5v3" />
                    <path d="M3.5 3.5 7 7" />
                    <path d="M9.5 12.5h3v-3" />
                    <path d="M12.5 12.5 9 9" />
                  </>
                ) : (
                  <>
                    <path d="M6.5 3.5h-3v3" />
                    <path d="M3.5 6.5 7 3" />
                    <path d="M9.5 12.5h3v-3" />
                    <path d="M12.5 9.5 9 13" />
                  </>
                )}
              </DockIcon>
            </button>
          </div>
        }
      />
    </section>
  );
}
