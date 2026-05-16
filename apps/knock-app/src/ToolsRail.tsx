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
