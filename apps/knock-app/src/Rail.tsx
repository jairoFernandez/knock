export type GlobalRailMode = "requests" | "kube";
export type ProjectRailMode = "workspace" | "files" | "git";

// Kept for backward compat; some legacy code may import it.
export type RailMode = GlobalRailMode | ProjectRailMode;

const REQUESTS_ICON = (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
    <path
      d="M4 5h12M4 10h12M4 15h8"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

const KUBE_ICON = (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
    <path
      d="M10 2l6 3v5c0 3.5-2.5 6.5-6 8-3.5-1.5-6-4.5-6-8V5l6-3z"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
    />
    <path d="M10 6.5v7M6.5 10h7" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

const WORKSPACE_ICON = (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
    <path
      d="M3 4h6v6H3zM11 4h6v6h-6zM3 12h6v4H3zM11 12h6v4h-6z"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
    />
  </svg>
);

const FILES_ICON = (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
    <path
      d="M3 5a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.5h6.5A1.5 1.5 0 0 1 17 6.5v8A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5v-9.5z"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
    />
  </svg>
);

const GIT_ICON = (
  <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
    <circle cx="6" cy="5" r="2" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <circle cx="6" cy="15" r="2" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <circle cx="14" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" fill="none" />
    <path d="M6 7v6M8 14l4-2M8 6l4 2" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

const GLOBAL_ITEMS: { mode: GlobalRailMode; label: string; icon: JSX.Element }[] = [
  { mode: "requests", label: "Requests", icon: REQUESTS_ICON },
  { mode: "kube", label: "Kubeconfigs", icon: KUBE_ICON },
];

const PROJECT_ITEMS: { mode: ProjectRailMode; label: string; icon: JSX.Element }[] = [
  { mode: "workspace", label: "Workspace", icon: WORKSPACE_ICON },
  { mode: "files", label: "Files", icon: FILES_ICON },
  { mode: "git", label: "Git", icon: GIT_ICON },
];

interface GlobalProps {
  mode: GlobalRailMode;
  onChange: (mode: GlobalRailMode) => void;
}

export function GlobalRail({ mode, onChange }: GlobalProps) {
  return (
    <div className="rail">
      {GLOBAL_ITEMS.map((item) => (
        <button
          key={item.mode}
          className={`rail-btn ${mode === item.mode ? "active" : ""}`}
          onClick={() => onChange(item.mode)}
          title={item.label}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

interface ProjectProps {
  mode: ProjectRailMode;
  onChange: (mode: ProjectRailMode) => void;
}

export function ProjectRail({ mode, onChange }: ProjectProps) {
  return (
    <div className="rail rail-project">
      {PROJECT_ITEMS.map((item) => (
        <button
          key={item.mode}
          className={`rail-btn ${mode === item.mode ? "active" : ""}`}
          onClick={() => onChange(item.mode)}
          title={item.label}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}

// Legacy export.
interface LegacyProps {
  mode: RailMode;
  onChange: (mode: RailMode) => void;
}
export function Rail({ mode, onChange }: LegacyProps) {
  return (
    <div className="rail">
      {GLOBAL_ITEMS.map((item) => (
        <button
          key={item.mode}
          className={`rail-btn ${mode === item.mode ? "active" : ""}`}
          onClick={() => onChange(item.mode)}
          title={item.label}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}
