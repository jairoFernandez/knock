import { useColumnDrag } from "./hooks";
import { KubeTerminalsPane } from "./KubeTerminalsPane";
import type { KubeTerminalSpawnArgs } from "./kubeTerminalStore";

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
        onTabCreated={() => onExpandedChange(true)}
        onTabSelected={() => onExpandedChange(true)}
        toolbar={
          <div className="bottom-terminal-actions">
            <button
              title={expanded ? "Collapse terminal" : "Open terminal"}
              onClick={() => onExpandedChange(!expanded)}
            >
              {expanded ? "▾" : "▴"}
            </button>
            <button
              title={maximized ? "Restore terminal" : "Maximize terminal"}
              onClick={() => {
                onMaximizedChange(!maximized);
                onExpandedChange(true);
              }}
            >
              {maximized ? "⤡" : "⤢"}
            </button>
          </div>
        }
      />
    </section>
  );
}
