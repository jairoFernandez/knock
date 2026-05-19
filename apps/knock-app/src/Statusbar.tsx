import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  workspaceRoot?: string | null;
  workspaceName?: string | null;
  envName?: string | null;
  hint?: string | null;
  scale?: number;
  onScaleChange?: (v: number) => void;
  onOpenShell?: () => void;
}

export const SCALE_MIN = 0.7;
export const SCALE_MAX = 1.8;
export const SCALE_STEP = 0.1;

export function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(v * 100) / 100));
}

function ZoomControl({ scale, onChange }: { scale: number; onChange: (v: number) => void }) {
  const pct = Math.round(scale * 100);
  return (
    <div className="statusbar-item zoom" title="UI text size (Cmd/Ctrl +/-/0)">
      <button
        className="zoom-btn"
        onClick={() => onChange(clampScale(scale - SCALE_STEP))}
        disabled={scale <= SCALE_MIN + 1e-3}
        aria-label="Decrease text size"
      >−</button>
      <button
        className="zoom-pct"
        onClick={() => onChange(1)}
        title="Reset to 100%"
      >{pct}%</button>
      <button
        className="zoom-btn"
        onClick={() => onChange(clampScale(scale + SCALE_STEP))}
        disabled={scale >= SCALE_MAX - 1e-3}
        aria-label="Increase text size"
      >+</button>
    </div>
  );
}

const REPO = "jairoFernandez/knock";
const REPO_URL = `https://github.com/${REPO}`;

interface RepoMeta {
  stars: number | null;
}

interface VersionInfo {
  version: string;
  commit: string;
  commitShort: string;
  commitUrl: string;
  releaseUrl: string;
}

interface SystemStats {
  cpuPercent: number;
  memUsed: number;
  memTotal: number;
  appMem: number;
  appCpu: number;
  cores: number;
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  const kb = b / 1024;
  if (kb < 1024) return `${kb.toFixed(0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function PerfBadge() {
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState<SystemStats | null>(null);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    async function tick() {
      try {
        const s = await invoke<SystemStats>("get_system_stats");
        if (!cancelled) setStats(s);
      } catch {
        /* non-fatal */
      }
    }
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [expanded]);

  return (
    <button
      className={`statusbar-item perf${expanded ? " expanded" : ""}`}
      onClick={() => setExpanded((v) => !v)}
      title={expanded ? "Hide system and app stats" : "Show system and app stats"}
    >
      <span className="perf-glyph">{expanded ? "▾" : "▸"}</span>
      <span>perf</span>
      {expanded && stats && (
        <>
          <span className="perf-stat">
            sys cpu {stats.cpuPercent.toFixed(0)}%
          </span>
          <span className="perf-stat">
            sys mem {fmtBytes(stats.memUsed)}/{fmtBytes(stats.memTotal)}
          </span>
          <span className="perf-stat">
            app cpu {stats.appCpu.toFixed(0)}%
          </span>
          <span className="perf-stat">
            app mem {fmtBytes(stats.appMem)}
          </span>
        </>
      )}
    </button>
  );
}

export function Statusbar({
  workspaceRoot,
  workspaceName,
  envName,
  hint,
  scale,
  onScaleChange,
  onOpenShell,
}: Props) {
  const [meta, setMeta] = useState<RepoMeta>({ stars: null });
  const [version, setVersion] = useState<VersionInfo | null>(null);

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
    invoke<VersionInfo>("version_info")
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch((e) => console.error("version_info failed", e));
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

  async function openVersion() {
    if (!version) return;
    try {
      await invoke("open_url", { url: version.releaseUrl });
    } catch (e) {
      console.error("open_url failed", e);
    }
  }

  async function openCommit() {
    if (!version) return;
    try {
      await invoke("open_url", { url: version.commitUrl });
    } catch (e) {
      console.error("open_url failed", e);
    }
  }

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {onOpenShell && (
          <button
            className="statusbar-item link"
            onClick={onOpenShell}
            title="Open a new shell in the bottom dock"
          >
            shell
          </button>
        )}
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
        {scale !== undefined && onScaleChange && (
          <ZoomControl scale={scale} onChange={onScaleChange} />
        )}
        <PerfBadge />
        {version && (
          <span
            className="statusbar-item version"
            title={`Version ${version.version} · commit ${version.commit}`}
          >
            <button
              className="version-tag"
              onClick={openVersion}
              title={`Open release ${version.version} on GitHub`}
            >
              {version.version}
            </button>
            <button
              className="version-commit"
              onClick={openCommit}
              title={`Open commit ${version.commit} on GitHub`}
            >
              @{version.commitShort}
            </button>
          </span>
        )}
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
