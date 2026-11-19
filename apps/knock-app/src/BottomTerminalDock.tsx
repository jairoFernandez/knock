import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useColumnDrag } from "./hooks";
import { KubeTerminalsPane } from "./KubeTerminalsPane";
import { TermIcon } from "./terminalIcons";
import {
  IS_MAC,
  listShells,
  shortcutLabel,
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
                } (${shortcutLabel("t", { shift: true })})`}
                onClick={() => {
                  void openNewShell();
                }}
              >
                <TermIcon name="plus" size={13} />
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
                  <TermIcon name="chevronDown" size={12} />
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
                          <TermIcon name="star" size={12} />
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
                  title={`Split right (${shortcutLabel("d", { shift: true })})`}
                  aria-label="Split right"
                  onClick={() => {
                    void terminalStore.splitActive("h");
                    onExpandedChange(true);
                  }}
                >
                  <TermIcon name="splitRight" />
                </button>
                <button
                  className="bottom-terminal-icon"
                  title={`Split down (${shortcutLabel("e", { shift: true })})`}
                  aria-label="Split down"
                  onClick={() => {
                    void terminalStore.splitActive("v");
                    onExpandedChange(true);
                  }}
                >
                  <TermIcon name="splitDown" />
                </button>
                <button
                  className="bottom-terminal-icon"
                  title={`Find in terminal (${shortcutLabel("f", { shift: !IS_MAC })})`}
                  aria-label="Find in terminal"
                  onClick={() => {
                    const id = terminalStore.getActiveTab()?.activeLeaf;
                    if (id) terminalStore.openFind(id);
                    onExpandedChange(true);
                  }}
                >
                  <TermIcon name="search" />
                </button>
                <button
                  className="bottom-terminal-icon"
                  title={`Reset input modes — fixes pasting after a process left bracketed paste on (${shortcutLabel("r", { shift: true })})`}
                  aria-label="Reset input modes"
                  onClick={() => {
                    terminalStore.resetInputModes();
                    onExpandedChange(true);
                  }}
                >
                  <TermIcon name="reset" />
                </button>
              </>
            )}
            <button
              className="bottom-terminal-icon"
              title={expanded ? "Collapse terminal" : "Open terminal"}
              aria-label={expanded ? "Collapse terminal" : "Open terminal"}
              onClick={() => {
                // Collapsing leaves maximized mode too, so re-opening restores
                // the normal height instead of jumping back to full screen.
                if (expanded && maximized) onMaximizedChange(false);
                onExpandedChange(!expanded);
              }}
            >
              <TermIcon name={expanded ? "chevronDown" : "chevronUp"} />
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
              <TermIcon name={maximized ? "restore" : "maximize"} />
            </button>
          </div>
        }
      />
    </section>
  );
}
