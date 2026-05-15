import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  CommitDto,
  FileChangeDto,
  GitStateDto,
  WorkingChangeDto,
} from "./types";

interface Props {
  root: string;
  onOpenFile?: (rel: string) => void;
}

function commitStatusClass(s: string): string {
  if (s.startsWith("A")) return "added";
  if (s.startsWith("M")) return "modified";
  if (s.startsWith("D")) return "deleted";
  if (s.startsWith("R")) return "renamed";
  return "neutral";
}

function workingClass(c: WorkingChangeDto): string {
  if (c.staged === "?" && c.unstaged === "?") return "untracked";
  if (c.staged !== " " && c.staged !== "?") return "staged";
  return "unstaged";
}

function workingLetter(c: WorkingChangeDto): string {
  if (c.staged === "?" && c.unstaged === "?") return "?";
  if (c.staged !== " " && c.staged !== "?") return c.staged;
  return c.unstaged;
}

function relDate(unixSecs: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSecs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}

export function GitPanel({ root, onOpenFile }: Props) {
  const [hasGit, setHasGit] = useState<boolean | null>(null);
  const [state, setState] = useState<GitStateDto | null>(null);
  const [commits, setCommits] = useState<CommitDto[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [changes, setChanges] = useState<FileChangeDto[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const ok = await invoke<boolean>("git_status", { root });
      setHasGit(ok);
      if (!ok) return;
      const [st, log] = await Promise.all([
        invoke<GitStateDto>("git_state", { root }),
        invoke<CommitDto[]>("git_log", { root, limit: 50 }),
      ]);
      setState(st);
      setCommits(log);
    } catch (e) {
      setError(String(e));
    }
  }, [root]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedHash) {
      setChanges([]);
      setSelectedFile(null);
      return;
    }
    invoke<FileChangeDto[]>("git_show_files", { root, hash: selectedHash })
      .then((c) => {
        setChanges(c);
        setSelectedFile(c[0]?.path ?? null);
      })
      .catch((e) => setError(String(e)));
  }, [root, selectedHash]);

  useEffect(() => {
    if (!selectedHash || !selectedFile) {
      setDiff("");
      return;
    }
    invoke<string>("git_diff", { root, hash: selectedHash, path: selectedFile })
      .then(setDiff)
      .catch((e) => setError(String(e)));
  }, [root, selectedHash, selectedFile]);

  async function toggleStage(change: WorkingChangeDto) {
    setBusy(true);
    try {
      const isStaged = change.staged !== " " && change.staged !== "?";
      if (isStaged) {
        await invoke("git_unstage", { root, paths: [change.path] });
      } else {
        await invoke("git_stage", { root, paths: [change.path] });
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function stageAll() {
    setBusy(true);
    try {
      await invoke("git_stage_all", { root });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!message.trim()) return;
    setBusy(true);
    try {
      await invoke("git_commit", { root, message: message.trim() });
      setMessage("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (hasGit === null) return <div className="empty">Loading…</div>;
  if (!hasGit) return <div className="empty">No git repo in this workspace.</div>;

  return (
    <div className="git-panel">
      {error && <div className="error">{error}</div>}

      <div className="git-branchline">
        <span className="git-branch-label">branch</span>
        <span className="git-branch-name">{state?.branch ?? "—"}</span>
        <span className="git-staged-info">
          {state ? `${state.stagedCount} staged · ${state.unstagedCount} dirty` : ""}
        </span>
        <button className="git-refresh" onClick={refresh} title="Refresh">
          ↻
        </button>
      </div>

      <div className="git-working">
        <div className="section-header git-working-header">
          <span>Working tree {state ? `· ${state.changes.length}` : ""}</span>
          {state && state.changes.length > 0 && (
            <button className="link-btn" onClick={stageAll} disabled={busy}>
              Stage all
            </button>
          )}
        </div>
        {state && state.changes.length === 0 && (
          <div className="empty git-clean">working tree clean</div>
        )}
        {state?.changes.map((c) => {
          const cls = workingClass(c);
          const staged = cls === "staged";
          return (
            <div key={c.path} className={`git-file-row ${cls}`}>
              <button
                className="git-stage-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleStage(c);
                }}
                title={staged ? "Unstage" : "Stage"}
                disabled={busy}
              >
                {staged ? "−" : "+"}
              </button>
              <span className={`git-status ${cls}`}>{workingLetter(c)}</span>
              <span
                className="git-file-path clickable"
                onClick={() => onOpenFile?.(c.path)}
                title="Open file"
              >
                {c.path}
              </span>
            </div>
          );
        })}
      </div>

      {state && state.stagedCount > 0 && (
        <div className="git-commit-form">
          <textarea
            className="git-commit-msg"
            placeholder="Commit message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") commit();
            }}
            rows={2}
          />
          <button
            className="primary git-commit-btn"
            onClick={commit}
            disabled={busy || !message.trim()}
          >
            Commit {state.stagedCount}
          </button>
        </div>
      )}

      <div className="git-commits">
        <div className="section-header">History · {commits.length}</div>
        {commits.length === 0 && (
          <div className="empty">No commits yet. Stage and commit to begin.</div>
        )}
        {commits.map((c) => (
          <div
            key={c.hash}
            className={`git-commit ${selectedHash === c.hash ? "selected" : ""}`}
            onClick={() => setSelectedHash(c.hash === selectedHash ? null : c.hash)}
            title={c.hash}
          >
            <div className="git-commit-row1">
              <span className="git-short">{c.short}</span>
              <span className="git-when">{relDate(c.date)}</span>
            </div>
            <div className="git-subject" title={c.subject}>
              {c.subject}
            </div>
            <div className="git-author">{c.author}</div>
          </div>
        ))}
      </div>

      {selectedHash && changes.length > 0 && (
        <div className="git-detail">
          <div className="section-header">Files · {changes.length}</div>
          <div className="git-files">
            {changes.map((c) => (
              <div
                key={c.path}
                className={`git-file-row ${selectedFile === c.path ? "selected" : ""}`}
                onClick={() => setSelectedFile(c.path)}
                title={c.path}
              >
                <span className={`git-status ${commitStatusClass(c.status)}`}>{c.status || "?"}</span>
                <span className="git-file-path">{c.path}</span>
                {onOpenFile && (
                  <button
                    className="git-open-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenFile(c.path);
                    }}
                    title="Open in editor"
                  >
                    ↗
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {selectedFile && diff && (
        <div className="git-diff">
          <div className="section-header">Diff</div>
          <pre>{highlightDiff(diff)}</pre>
        </div>
      )}
    </div>
  );
}

function highlightDiff(diff: string): JSX.Element[] {
  return diff.split("\n").map((line, i) => {
    let cls = "diff-line";
    if (line.startsWith("+++") || line.startsWith("---")) cls += " meta";
    else if (line.startsWith("@@")) cls += " hunk";
    else if (line.startsWith("+")) cls += " add";
    else if (line.startsWith("-")) cls += " del";
    else if (line.startsWith("diff ")) cls += " meta";
    return (
      <span key={i} className={cls}>
        {line || " "}
        {"\n"}
      </span>
    );
  });
}
