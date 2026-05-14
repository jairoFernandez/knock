export type RailMode = "workspace" | "files" | "git";

interface Props {
  mode: RailMode;
  onChange: (mode: RailMode) => void;
}

const ITEMS: { mode: RailMode; label: string; icon: JSX.Element }[] = [
  {
    mode: "workspace",
    label: "Requests",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <path d="M4 5h12M4 10h12M4 15h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    mode: "files",
    label: "Files",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <path d="M3 5a1 1 0 011-1h4l2 2h6a1 1 0 011 1v8a1 1 0 01-1 1H4a1 1 0 01-1-1V5z" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    ),
  },
  {
    mode: "git",
    label: "Git",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="6" cy="14" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="14" cy="10" r="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M6 8v4M8 6c4 0 4 4 4 4" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
    ),
  },
];

export function Rail({ mode, onChange }: Props) {
  return (
    <div className="rail">
      {ITEMS.map((item) => (
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
