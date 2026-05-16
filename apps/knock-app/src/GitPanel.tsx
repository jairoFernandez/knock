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

interface RemoteDto {
  name: string;
  url: string;
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

function shortAgo(msEpoch: number, now: number): string {
  const diff = Math.floor((now - msEpoch) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
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
  const [remotes, setRemotes] = useState<RemoteDto[]>([]);
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [remoteName, setRemoteName] = useState("origin");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const ok = await invoke<boolean>("git_status", { root });
      setHasGit(ok);
      if (!ok) return;
      const [st, log, rem] = await Promise.all([
        invoke<GitStateDto>("git_state", { root }),
        invoke<CommitDto[]>("git_log", { root, limit: 50 }),
        invoke<RemoteDto[]>("git_remotes", { root }).catch(() => [] as RemoteDto[]),
      ]);
      setState(st);
      setCommits(log);
      setRemotes(rem);
      setLastRefreshAt(Date.now());
    } catch (e) {
      setError(String(e));
    }
  }, [root]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Tick clock + auto-refresh.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(tick);
  }, []);
  useEffect(() => {
    const auto = setInterval(() => refresh(), 15000);
    return () => clearInterval(auto);
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

  async function addRemote() {
    if (!remoteName.trim() || !remoteUrl.trim()) return;
    setBusy(true);
    try {
      await invoke("git_add_remote", { root, name: remoteName.trim(), url: remoteUrl.trim() });
      setShowAddRemote(false);
      setRemoteUrl("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    try {
      await invoke("open_in_file_manager", { path: root });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openTerm() {
    try {
      await invoke("open_terminal", { path: root });
    } catch (e) {
      setError(String(e));
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

      <div className="git-statusbar">
        <div className="git-statusbar-row">
          <span className="git-branch-label">branch</span>
          <span className="git-branch-name">{state?.branch ?? "—"}</span>
          {state?.upstream && (
            <span className="git-upstream" title={`tracking ${state.upstream}`}>
              ↦ {state.upstream}
            </span>
          )}
          {state && state.ahead > 0 && (
            <span className="git-ab ahead" title={`${state.ahead} commit(s) to push`}>
              ↑{state.ahead}
            </span>
          )}
          {state && state.behind > 0 && (
            <span className="git-ab behind" title={`${state.behind} commit(s) to pull`}>
              ↓{state.behind}
            </span>
          )}
          <span className="git-statusbar-actions">
            <button className="git-refresh" onClick={openFolder} title="Reveal in file manager">⌂</button>
            <button className="git-refresh" onClick={openTerm} title="Open terminal here">▭</button>
            <button className="git-refresh" onClick={refresh} title="Refresh">↻</button>
          </span>
        </div>
        <div className="git-statusbar-row sub">
          {state && state.changes.length === 0 ? (
            <span className="git-pill clean">✓ clean</span>
          ) : (
            <span className="git-pill dirty">
              {state ? `${state.changes.length} change${state.changes.length === 1 ? "" : "s"}` : ""}
              {state && state.stagedCount > 0 && (
                <span className="git-pill-sub"> · {state.stagedCount} staged</span>
              )}
            </span>
          )}
          {lastRefreshAt && (
            <span className="git-refresh-time" title={new Date(lastRefreshAt).toLocaleTimeString()}>
              updated {shortAgo(lastRefreshAt, now)}
            </span>
          )}
        </div>
        {state?.lastCommitSubject && (
          <div className="git-statusbar-row last-commit" title={state.lastCommitSubject}>
            <span className="git-last-label">last</span>
            {state.lastCommitShort && (
              <span className="git-last-short">{state.lastCommitShort}</span>
            )}
            <span className="git-last-subject">{state.lastCommitSubject}</span>
            {state.lastCommitAt && (
              <span className="git-last-when">· {relDate(state.lastCommitAt)}</span>
            )}
          </div>
        )}
      </div>

      <div className="git-remotes-section">
        <div className="section-header git-remotes-header">
          <span>Remotes · {remotes.length}</span>
          {!showAddRemote && (
            <button className="link-btn" onClick={() => setShowAddRemote(true)} disabled={busy}>
              + Add
            </button>
          )}
        </div>
        {remotes.length === 0 && !showAddRemote && (
          <div className="git-remote-empty">
            <div className="git-remote-empty-msg">
              No remotes yet. Push your work to GitHub/GitLab/etc.
            </div>
            <ol className="git-remote-steps">
              <li>Create an empty repo on your host (no README/license).</li>
              <li>Copy its URL (e.g. <code>git@github.com:you/knock-ws.git</code>).</li>
              <li>Click <b>+ Add</b>, paste the URL, save.</li>
              <li>Then in a terminal: <code>git push -u origin {state?.branch ?? "main"}</code></li>
            </ol>
          </div>
        )}
        {remotes.map((r) => (
          <div className="git-remote-row" key={r.name}>
            <span className="git-remote-name">{r.name}</span>
            <span className="git-remote-url" title={r.url}>{r.url}</span>
          </div>
        ))}
        {showAddRemote && (
          <div className="git-remote-form">
            <input
              className="git-remote-input"
              type="text"
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
              placeholder="origin"
            />
            <input
              className="git-remote-input wide"
              type="text"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="git@github.com:you/repo.git"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") addRemote();
                else if (e.key === "Escape") setShowAddRemote(false);
              }}
            />
            <div className="git-remote-actions">
              <button onClick={() => setShowAddRemote(false)} disabled={busy}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={addRemote}
                disabled={busy || !remoteName.trim() || !remoteUrl.trim()}
              >
                Add remote
              </button>
            </div>
            <div className="git-remote-hint">
              After adding: open a terminal in this workspace and run
              <code> git push -u {remoteName.trim() || "origin"} {state?.branch ?? "main"}</code>
            </div>
          </div>
        )}
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
