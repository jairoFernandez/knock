import { TOOL_MAP, type ToolKey } from "./tools/registry";
import { useFavorites } from "./tools/ToolsDashboard";

interface Props {
  active: ToolKey | null;
  onToggle: (tool: ToolKey) => void;
}

export function ToolsRail({ active, onToggle }: Props) {
  const { favorites } = useFavorites();
  return (
    <div className="tools-rail">
      <button
        className={`rail-btn tools-rail-btn tools-rail-dash ${active === "dashboard" ? "active" : ""}`}
        onClick={() => onToggle("dashboard")}
        title="Tools dashboard"
      >
        <span className="tools-rail-text">≡</span>
      </button>
      <div className="tools-rail-divider" />
      {favorites.map((key) => {
        const def = TOOL_MAP[key];
        if (!def) return null;
        return (
          <button
            key={key}
            className={`rail-btn tools-rail-btn ${active === key ? "active" : ""}`}
            onClick={() => onToggle(key)}
            title={`${def.title} — ${def.description}`}
          >
            <span className="tools-rail-text">{def.short}</span>
          </button>
        );
      })}
    </div>
  );
}
