import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CommitDto, FileChangeDto } from "./types";

interface Props {
  root: string;
}

function statusClass(s: string): string {
  if (s.startsWith("A")) return "added";
  if (s.startsWith("M")) return "modified";
  if (s.startsWith("D")) return "deleted";
  if (s.startsWith("R")) return "renamed";
  return "neutral";
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

export function GitPanel({ root }: Props) {
  const [hasGit, setHasGit] = useState<boolean | null>(null);
  const [commits, setCommits] = useState<CommitDto[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [changes, setChanges] = useState<FileChangeDto[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>("git_status", { root })
      .then((ok) => {
        setHasGit(ok);
        if (ok) {
          invoke<CommitDto[]>("git_log", { root, limit: 50 })
            .then(setCommits)
            .catch((e) => setError(String(e)));
        }
      })
      .catch((e) => setError(String(e)));
  }, [root]);

  useEffect(() => {
    if (!selectedHash) return;
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

  if (hasGit === null) {
    return <div className="empty">Loading…</div>;
  }
  if (!hasGit) {
    return <div className="empty">No git repo in this workspace.</div>;
  }

  return (
    <div className="git-panel">
      {error && <div className="error">{error}</div>}
      <div className="git-commits">
        <div className="section-header">Commits · {commits.length}</div>
        {commits.length === 0 && <div className="empty">No commits yet.</div>}
        {commits.map((c) => (
          <div
            key={c.hash}
            className={`git-commit ${selectedHash === c.hash ? "selected" : ""}`}
            onClick={() => setSelectedHash(c.hash)}
            title={c.hash}
          >
            <div className="git-commit-row1">
              <span className="git-short">{c.short}</span>
              <span className="git-when">{relDate(c.date)}</span>
            </div>
            <div className="git-subject" title={c.subject}>{c.subject}</div>
            <div className="git-author">{c.author}</div>
          </div>
        ))}
      </div>

      {selectedHash && (
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
                <span className={`git-status ${statusClass(c.status)}`}>{c.status || "?"}</span>
                <span className="git-file-path">{c.path}</span>
              </div>
            ))}
            {changes.length === 0 && <div className="empty">No file changes.</div>}
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
