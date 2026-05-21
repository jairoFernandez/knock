import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { RecentEntry, WorkspaceInfo } from "./types";
import type { ConfirmOptions } from "./ConfirmDialog";

interface Props {
  onOpen: (root: string) => void;
  onPickDirectory: () => void;
  onCreate: () => void;
  onLoadInfo?: (info: WorkspaceInfo) => void;
  confirm?: (opts: ConfirmOptions) => Promise<boolean>;
}

function timeAgo(unixSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSecs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  const months = Math.floor(diff / (86400 * 30));
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path;
}

interface RecentCardProps {
  entry: RecentEntry;
  onOpen: (root: string) => void;
  onForget: (root: string) => void;
  onToggleFavorite: (root: string, fav: boolean) => void;
}

function RecentCard({ entry, onOpen, onForget, onToggleFavorite }: RecentCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.root });
  const accent = entry.color || undefined;
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    ...(accent ? { borderColor: accent, boxShadow: `inset 4px 0 0 0 ${accent}` } : {}),
  };
  return (
    <div className="card card-recent" ref={setNodeRef} style={style}>
      <button
        type="button"
        className={`card-fav${entry.favorite ? " on" : ""}`}
        title={entry.favorite ? "Unpin favorite" : "Pin as favorite"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(entry.root, !entry.favorite);
        }}
      >
        ★
      </button>
      <button
        type="button"
        className="card-drag-handle"
        title="Drag to reorder"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <div
        className="card-clickable"
        onClick={() => onOpen(entry.root)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(entry.root);
        }}
      >
        <div className="card-recent-head">
          {entry.icon && (
            <span
              className="card-recent-icon"
              style={accent ? { color: accent } : undefined}
            >
              {entry.icon}
            </span>
          )}
          <div className="card-title" title={entry.name ?? basename(entry.root)}>
            {entry.name ?? basename(entry.root)}
          </div>
        </div>
        <div className="card-sub" title={entry.root}>
          {entry.root}
        </div>
        <div className="card-meta">opened {timeAgo(entry.lastOpened)}</div>
      </div>
      <button
        className="card-forget"
        title="Remove from list"
        onClick={(e) => {
          e.stopPropagation();
          onForget(entry.root);
        }}
      >
        ×
      </button>
    </div>
  );
}

export function Dashboard({ onOpen, onPickDirectory, onCreate, onLoadInfo, confirm }: Props) {
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [exampleBusy, setExampleBusy] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  useEffect(() => {
    invoke<RecentEntry[]>("list_recents")
      .then(setRecents)
      .catch(() => setRecents([]))
      .finally(() => setLoaded(true));
  }, []);

  async function loadExample() {
    if (exampleBusy) return;
    setExampleBusy(true);
    try {
      const info = await invoke<WorkspaceInfo>("init_example_workspace");
      if (onLoadInfo) onLoadInfo(info);
      else onOpen(info.root);
    } catch (e) {
      console.error(e);
    } finally {
      setExampleBusy(false);
    }
  }

  async function forget(root: string) {
    if (confirm) {
      const ok = await confirm({
        title: "Remove from recents",
        message: `Remove ${root} from the recents list? This does not delete the workspace on disk.`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
    }
    try {
      await invoke("forget_recent", { root });
      setRecents((r) => r.filter((e) => e.root !== root));
    } catch {
      /* ignore */
    }
  }

  async function toggleFavorite(root: string, fav: boolean) {
    setRecents((prev) => prev.map((e) => (e.root === root ? { ...e, favorite: fav } : e)));
    try {
      await invoke("set_recent_favorite", { root, favorite: fav });
    } catch (e) {
      console.error("set_recent_favorite failed", e);
    }
  }

  async function persistOrder(next: RecentEntry[]) {
    try {
      await invoke("reorder_recents", { roots: next.map((e) => e.root) });
    } catch (e) {
      console.error("reorder_recents failed", e);
    }
  }

  function onDragEnd(section: "fav" | "rest") {
    return (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setRecents((prev) => {
        const list = section === "fav" ? favs : rest;
        const ids = list.map((e) => e.root);
        const from = ids.indexOf(String(active.id));
        const to = ids.indexOf(String(over.id));
        if (from < 0 || to < 0) return prev;
        const reordered = arrayMove(list, from, to);
        const next = section === "fav" ? [...reordered, ...rest] : [...favs, ...reordered];
        persistOrder(next);
        return next;
      });
    };
  }

  const favs = useMemo(() => recents.filter((e) => e.favorite), [recents]);
  const rest = useMemo(() => recents.filter((e) => !e.favorite), [recents]);

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        <div className="dashboard-header">
          <div className="dashboard-mark">KNOCK</div>
          <div className="dashboard-sub">Pick a workspace to start.</div>
        </div>

        <div className="dashboard-section-title">Actions</div>
        <div className="dashboard-actions">
          <button className="card card-action card-create" onClick={onCreate}>
            <div className="card-icon">+</div>
            <div className="card-title">New workspace</div>
            <div className="card-sub">Scaffold a fresh repo</div>
          </button>
          <button className="card card-action" onClick={onPickDirectory}>
            <div className="card-icon">⌂</div>
            <div className="card-title">Open from disk…</div>
            <div className="card-sub">Browse for a knock.toml</div>
          </button>
          <button
            className="card card-action"
            onClick={loadExample}
            disabled={exampleBusy}
          >
            <div className="card-icon">★</div>
            <div className="card-title">
              {exampleBusy ? "Loading…" : "PokeAPI example"}
            </div>
            <div className="card-sub">Try a ready-made workspace</div>
          </button>
        </div>

        {favs.length > 0 && (
          <>
            <div className="dashboard-section-title">Favorites</div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd("fav")}>
              <SortableContext items={favs.map((e) => e.root)} strategy={rectSortingStrategy}>
                <div className="dashboard-grid">
                  {favs.map((entry) => (
                    <RecentCard
                      key={entry.root}
                      entry={entry}
                      onOpen={onOpen}
                      onForget={forget}
                      onToggleFavorite={toggleFavorite}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          </>
        )}

        <div className="dashboard-section-title">Projects</div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd("rest")}>
          <SortableContext items={rest.map((e) => e.root)} strategy={rectSortingStrategy}>
            <div className="dashboard-grid">
              {loaded && rest.length === 0 && favs.length === 0 && (
                <div className="card card-placeholder">
                  <div className="card-title">No recents yet</div>
                  <div className="card-sub">Open or create a workspace and it shows up here.</div>
                </div>
              )}
              {rest.map((entry) => (
                <RecentCard
                  key={entry.root}
                  entry={entry}
                  onOpen={onOpen}
                  onForget={forget}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}
