import { useState } from "react";
import { DEFAULT_FAVORITES, GROUPS, TOOLS, type ToolKey } from "./registry";
import { usePersistedField } from "./shared";

interface Props {
  onOpen: (key: ToolKey) => void;
}

export function useFavorites() {
  const [favorites, setFavorites] = usePersistedField<ToolKey[]>(
    "knock.tools.favorites",
    DEFAULT_FAVORITES,
  );
  function toggle(key: ToolKey) {
    if (favorites.includes(key)) setFavorites(favorites.filter((k) => k !== key));
    else setFavorites([...favorites, key]);
  }
  function reorder(from: number, to: number) {
    if (from === to) return;
    const next = favorites.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setFavorites(next);
  }
  return { favorites, toggle, reorder, setFavorites };
}

export function ToolsDashboard({ onOpen }: Props) {
  const { favorites, toggle, reorder, setFavorites } = useFavorites();
  const [search, setSearch] = useState("");
  const [drag, setDrag] = useState<ToolKey | null>(null);

  const grouped = GROUPS.map((g) => ({
    ...g,
    tools: TOOLS.filter(
      (t) =>
        t.group === g.key &&
        (search === "" ||
          t.title.toLowerCase().includes(search.toLowerCase()) ||
          t.description.toLowerCase().includes(search.toLowerCase())),
    ),
  })).filter((g) => g.tools.length > 0);

  function onDragStart(e: React.DragEvent, key: ToolKey) {
    setDrag(key);
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData("text/plain", key);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = drag && favorites.includes(drag) ? "move" : "copy";
  }
  function onDropAdd(e: React.DragEvent) {
    e.preventDefault();
    const key = (e.dataTransfer.getData("text/plain") || drag) as ToolKey | "";
    if (key && !favorites.includes(key as ToolKey)) toggle(key as ToolKey);
    setDrag(null);
  }
  function onDropReorder(e: React.DragEvent, targetKey: ToolKey) {
    e.preventDefault();
    e.stopPropagation();
    const src = (e.dataTransfer.getData("text/plain") || drag) as ToolKey | "";
    if (!src) return;
    const srcIdx = favorites.indexOf(src as ToolKey);
    const tgtIdx = favorites.indexOf(targetKey);
    if (srcIdx === -1) {
      // adding new fav at target position
      if (!favorites.includes(src as ToolKey)) {
        const next = favorites.slice();
        next.splice(tgtIdx, 0, src as ToolKey);
        setFavorites(next);
      }
    } else {
      reorder(srcIdx, tgtIdx);
    }
    setDrag(null);
  }

  return (
    <>
      <div className="tools-output-header">
        <span>Tools dashboard</span>
      </div>
      <input
        type="text"
        className="tools-input"
        placeholder="Search tools…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        spellCheck={false}
      />

      <div className="tools-output-header">
        <span>Favorites ({favorites.length})</span>
        <span className="tools-hint">Shown in rail · drag tool to add</span>
      </div>
      <div className="tools-dash-fav-zone" onDragOver={onDragOver} onDrop={onDropAdd}>
        {favorites.length === 0 && (
          <div className="tools-dash-empty">No favorites yet. Drop a tool here or click ★.</div>
        )}
        {favorites.map((key) => {
          const tool = TOOLS.find((t) => t.key === key);
          if (!tool) return null;
          return (
            <div
              key={key}
              className={`tools-dash-fav ${drag === key ? "dragging" : ""}`}
              draggable
              onDragStart={(e) => onDragStart(e, key)}
              onDragEnd={() => setDrag(null)}
              onDragOver={onDragOver}
              onDrop={(e) => onDropReorder(e, key)}
            >
              <button
                className="tools-dash-fav-btn"
                onClick={() => onOpen(key)}
                title={tool.description}
              >
                <span className="tools-dash-short">{tool.short}</span>
                <span className="tools-dash-fav-title">{tool.title}</span>
              </button>
              <button
                className="tools-dash-star active"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(key);
                }}
                title="Remove from favorites"
              >
                ★
              </button>
            </div>
          );
        })}
      </div>

      {grouped.map((g) => (
        <details key={g.key} open className="tools-dash-group">
          <summary>{g.label}</summary>
          <div className="tools-dash-grid">
            {g.tools.map((t) => {
              const fav = favorites.includes(t.key);
              return (
                <div
                  key={t.key}
                  className={`tools-dash-card ${drag === t.key ? "dragging" : ""}`}
                  draggable
                  onDragStart={(e) => onDragStart(e, t.key)}
                  onDragEnd={() => setDrag(null)}
                >
                  <button
                    className="tools-dash-card-open"
                    onClick={() => onOpen(t.key)}
                    title="Open"
                  >
                    <span className="tools-dash-short">{t.short}</span>
                    <span className="tools-dash-card-title">{t.title}</span>
                    <span className="tools-dash-card-desc">{t.description}</span>
                  </button>
                  <button
                    className={`tools-dash-star ${fav ? "active" : ""}`}
                    onClick={() => toggle(t.key)}
                    title={fav ? "Remove from favorites" : "Add to favorites"}
                  >
                    {fav ? "★" : "☆"}
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      ))}
    </>
  );
}
