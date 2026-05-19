import { useColumnDrag } from "./hooks";
import { KubeTerminalsPane } from "./KubeTerminalsPane";
import { terminalStore, type KubeTerminalSpawnArgs } from "./kubeTerminalStore";

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

  async function openNewShell() {
    if (spawnArgs) {
      await terminalStore.openNewTab(spawnArgs);
    } else {
      await terminalStore.openGeneralTab();
    }
    onExpandedChange(true);
  }

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
            <button
              className="bottom-terminal-new"
              title={
                spawnArgs
                  ? `New terminal for ${spawnArgs.project}/${spawnArgs.name}`
                  : "New plain shell"
              }
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
