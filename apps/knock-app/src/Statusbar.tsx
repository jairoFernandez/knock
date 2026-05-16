import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  workspaceRoot?: string | null;
  workspaceName?: string | null;
  envName?: string | null;
  hint?: string | null;
}

const REPO = "jairoFernandez/knock";
const REPO_URL = `https://github.com/${REPO}`;

interface RepoMeta {
  stars: number | null;
}

export function Statusbar({ workspaceRoot, workspaceName, envName, hint }: Props) {
  const [meta, setMeta] = useState<RepoMeta>({ stars: null });

  useEffect(() => {
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j) return;
        if (typeof j.stargazers_count === "number") {
          setMeta({ stars: j.stargazers_count });
        }
      })
      .catch(() => {
        /* offline ok */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function openRepo() {
    try {
      await invoke("open_url", { url: REPO_URL });
    } catch (e) {
      console.error("open_url failed", e);
    }
  }

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {workspaceRoot ? (
          <>
            <span className="statusbar-item" title={workspaceRoot}>
              ◆ {workspaceName ?? workspaceRoot.split("/").pop()}
            </span>
            {envName && (
              <span className="statusbar-item dim" title="Active environment">
                env: {envName}
              </span>
            )}
          </>
        ) : (
          <span className="statusbar-item dim">no workspace</span>
        )}
        {hint && <span className="statusbar-item dim">{hint}</span>}
      </div>
      <div className="statusbar-right">
        <button
          className="statusbar-item link"
          onClick={openRepo}
          title="Open repository on GitHub"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
            <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 005.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 014 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          <span>{meta.stars !== null ? `★ ${meta.stars}` : "GitHub"}</span>
        </button>
        <span className="statusbar-item dim">Made with ♥</span>
      </div>
    </div>
  );
}
