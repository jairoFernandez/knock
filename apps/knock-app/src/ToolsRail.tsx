import type { ToolKey } from "./ToolsPanel";

interface Props {
  active: ToolKey | null;
  onToggle: (tool: ToolKey) => void;
}

const ITEMS: { key: ToolKey; label: string; icon: JSX.Element }[] = [
  {
    key: "base64",
    label: "Base64",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <text x="10" y="14" fontSize="9" fontWeight="700" fontFamily="ui-monospace,monospace" textAnchor="middle" fill="currentColor">B64</text>
      </svg>
    ),
  },
  {
    key: "jwt",
    label: "JWT decode",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <text x="10" y="14" fontSize="9" fontWeight="700" fontFamily="ui-monospace,monospace" textAnchor="middle" fill="currentColor">JWT</text>
      </svg>
    ),
  },
  {
    key: "url",
    label: "URL encode/decode",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <text x="10" y="14" fontSize="9" fontWeight="700" fontFamily="ui-monospace,monospace" textAnchor="middle" fill="currentColor">URL</text>
      </svg>
    ),
  },
  {
    key: "random",
    label: "Random generator (UUID/bytes/password)",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <rect x="3" y="3" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="7" cy="7" r="1.2" fill="currentColor" />
        <circle cx="13" cy="7" r="1.2" fill="currentColor" />
        <circle cx="10" cy="10" r="1.2" fill="currentColor" />
        <circle cx="7" cy="13" r="1.2" fill="currentColor" />
        <circle cx="13" cy="13" r="1.2" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: "date",
    label: "Date / epoch converter",
    icon: (
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
        <rect x="3" y="4" width="14" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3 8 H17" stroke="currentColor" strokeWidth="1.4" />
        <path d="M7 2 V5 M13 2 V5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function ToolsRail({ active, onToggle }: Props) {
  return (
    <div className="tools-rail">
      {ITEMS.map((item) => (
        <button
          key={item.key}
          className={`rail-btn ${active === item.key ? "active" : ""}`}
          onClick={() => onToggle(item.key)}
          title={item.label}
        >
          {item.icon}
        </button>
      ))}
    </div>
  );
}
