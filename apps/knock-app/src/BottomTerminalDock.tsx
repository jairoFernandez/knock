import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
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
  // Anchor position for the shell menu. The menu renders in a portal on
  // document.body: the dock and the tab row both clip overflow, so an
  // absolutely-positioned dropdown inside them is invisible.
  const [menuPos, setMenuPos] = useState<
    { right: number; top?: number; bottom?: number } | null
  >(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuElRef = useRef<HTMLDivElement>(null);

  // The default shell is persisted app-wide (same setting as Kubeconfigs →
  // Settings); mirror it here so the dock can show and change it without
  // sending the user hunting for that panel.
  const [defaultShell, setDefaultShell] = useState<string>("auto");

  useEffect(() => {
    void listShells().then(setShells);
    void invoke<{ preferredShell: string }>("kubeconfig_settings_get")
      .then((s) => setDefaultShell(s.preferredShell || "auto"))
      .catch(() => undefined);
  }, []);

  async function makeDefaultShell(id: string) {
    setDefaultShell(id);
    try {
      await invoke("kubeconfig_settings_set", { preferredShell: id });
    } catch {
      /* keep the optimistic value; the next open re-reads the real one */
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(ev: MouseEvent) {
      const t = ev.target as Node;
      if (menuRef.current?.contains(t) || menuElRef.current?.contains(t)) return;
      setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  function toggleMenu() {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    const rect = menuRef.current?.getBoundingClientRect();
    if (rect) {
      const right = Math.max(0, window.innerWidth - rect.right);
      // Open upward by default; flip downward when the anchor sits near the
      // top of the window (maximized dock) and the menu would be cut off.
      if (rect.top < 280) {
        setMenuPos({ right, top: rect.bottom + 4 });
      } else {
        setMenuPos({ right, bottom: Math.max(0, window.innerHeight - rect.top + 4) });
      }
    }
    setMenuOpen(true);
  }

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
                  onClick={toggleMenu}
                >
                  <DockIcon size={11}>
                    <path d="M4 6.5 8 10l4-3.5" />
                  </DockIcon>
                </button>
              )}
              {menuOpen &&
                pickable.length > 0 &&
                menuPos &&
                createPortal(
                  <div
                    ref={menuElRef}
                    className="bottom-terminal-shell-menu"
                    role="menu"
                    style={{
                      position: "fixed",
                      right: menuPos.right,
                      top: menuPos.top,
                      bottom: menuPos.bottom,
                    }}
                  >
                    {pickable.map((s) => (
                      <div key={s.id} className="bottom-terminal-shell-row">
                        <button
                          role="menuitem"
                          className="bottom-terminal-shell-item"
                          onClick={() => {
                            setMenuOpen(false);
                            void openNewShell(s.id);
                          }}
                        >
                          {s.label}
                          {s.id === defaultShell && (
                            <span className="bottom-terminal-shell-default">
                              default
                            </span>
                          )}
                        </button>
                        {/* Pin as default without leaving the dock — the same
                            setting lives in Kubeconfigs → Settings, which is
                            not where anyone looks for it. */}
                        <button
                          className="bottom-terminal-shell-pin"
                          title={
                            s.id === defaultShell
                              ? `${s.label} is the default shell`
                              : `Make ${s.label} the default shell`
                          }
                          aria-label={`Make ${s.label} the default shell`}
                          aria-pressed={s.id === defaultShell}
                          disabled={s.id === defaultShell}
                          onClick={(e) => {
                            e.stopPropagation();
                            void makeDefaultShell(s.id);
                          }}
                        >
                          <DockIcon size={11}>
                            <path d="M8 2.5 9.6 6l3.9.4-2.9 2.6.8 3.8L8 11l-3.4 1.8.8-3.8L2.5 6.4 6.4 6z" />
                          </DockIcon>
                        </button>
                      </div>
                    ))}
                  </div>,
                  document.body,
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
                <button
                  className="bottom-terminal-icon"
                  title="Reset input modes — fixes pasting after a process left bracketed paste on (Ctrl/Cmd+Shift+R)"
                  aria-label="Reset input modes"
                  onClick={() => {
                    terminalStore.resetInputModes();
                    onExpandedChange(true);
                  }}
                >
                  <DockIcon size={13}>
                    <path d="M13 8a5 5 0 1 1-1.6-3.7" />
                    <path d="M13 2.5V5h-2.5" />
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
