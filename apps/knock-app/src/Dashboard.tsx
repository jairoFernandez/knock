import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RecentEntry } from "./types";

interface Props {
  onOpen: (root: string) => void;
  onPickDirectory: () => void;
  onCreate: () => void;
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

export function Dashboard({ onOpen, onPickDirectory, onCreate }: Props) {
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    invoke<RecentEntry[]>("list_recents")
      .then(setRecents)
      .catch(() => setRecents([]))
      .finally(() => setLoaded(true));
  }, []);

  async function forget(root: string) {
    try {
      await invoke("forget_recent", { root });
      setRecents((r) => r.filter((e) => e.root !== root));
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="dashboard">
      <div className="dashboard-inner">
        <div className="dashboard-header">
          <div className="dashboard-mark">KNOCK</div>
          <div className="dashboard-sub">Pick a workspace to start.</div>
        </div>

        <div className="dashboard-grid">
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

          {loaded && recents.length === 0 && (
            <div className="card card-placeholder">
              <div className="card-title">No recents yet</div>
              <div className="card-sub">Open or create a workspace and it shows up here.</div>
            </div>
          )}

          {recents.map((entry) => (
            <div className="card card-recent" key={entry.root}>
              <div
                className="card-clickable"
                onClick={() => onOpen(entry.root)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onOpen(entry.root);
                }}
              >
                <div className="card-title" title={entry.name ?? basename(entry.root)}>
                  {entry.name ?? basename(entry.root)}
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
                  forget(entry.root);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
