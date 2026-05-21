import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  repo: string;
  stars: number | null;
  version?: string | null;
  releaseUrl?: string | null;
  onClose: () => void;
}

interface Stargazer {
  login: string;
  avatar_url: string;
  html_url: string;
}

type Tab = "about" | "stargazers";

const CACHE_KEY = "knock.stargazers.cache";
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheShape {
  fetched_at: number;
  repo: string;
  users: Stargazer[];
}

function loadCache(repo: string): Stargazer[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheShape;
    if (parsed.repo !== repo) return null;
    if (Date.now() - parsed.fetched_at > CACHE_TTL_MS) return null;
    return parsed.users;
  } catch {
    return null;
  }
}

function saveCache(repo: string, users: Stargazer[]): void {
  try {
    const payload: CacheShape = { fetched_at: Date.now(), repo, users };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* non-fatal */
  }
}

async function fetchStargazers(repo: string): Promise<Stargazer[]> {
  const out: Stargazer[] = [];
  let page = 1;
  const perPage = 100;
  const maxPages = 5;
  while (page <= maxPages) {
    const url = `https://api.github.com/repos/${repo}/stargazers?per_page=${perPage}&page=${page}`;
    const resp = await fetch(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) break;
    const data = (await resp.json()) as Stargazer[];
    if (!Array.isArray(data) || data.length === 0) break;
    for (const u of data) {
      out.push({ login: u.login, avatar_url: u.avatar_url, html_url: u.html_url });
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return out;
}

export function AboutModal({ repo, stars, version, releaseUrl, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("about");
  const [users, setUsers] = useState<Stargazer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab !== "stargazers" || users !== null) return;
    const cached = loadCache(repo);
    if (cached) {
      setUsers(cached);
      return;
    }
    setLoading(true);
    setError(null);
    fetchStargazers(repo)
      .then((u) => {
        setUsers(u);
        saveCache(repo, u);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [tab, users, repo]);

  async function openUrl(url: string) {
    try {
      await invoke("open_url", { url });
    } catch (e) {
      console.error("open_url failed", e);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <div className="about-brand">
            <div className="about-logo">K</div>
            <div>
              <h2>Knock</h2>
              <div className="about-sub">
                HTTP client + workspace toolkit
                {version && <> · <span className="about-ver">{version}</span></>}
              </div>
            </div>
          </div>
          <button className="about-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="about-tabs">
          <button
            className={`about-tab${tab === "about" ? " active" : ""}`}
            onClick={() => setTab("about")}
          >
            What is this?
          </button>
          <button
            className={`about-tab${tab === "stargazers" ? " active" : ""}`}
            onClick={() => setTab("stargazers")}
          >
            Stargazers{stars !== null ? ` (${stars})` : ""}
          </button>
        </div>

        <div className="about-body">
          {tab === "about" ? (
            <div className="about-content">
              <p>
                <b>Knock</b> is a git-native HTTP client. Requests live as TOML files
                inside a workspace you check into your repo — review them in PRs,
                share them with your team, and diff them like any other source.
              </p>
              <ul>
                <li><b>Modular requests</b> — TOML files, fragments, reusable headers.</li>
                <li><b>Environments</b> — local/dev/prod with overrides + variables.</li>
                <li><b>Flows</b> — chained requests with assertions, run as one.</li>
                <li><b>OpenAPI import</b> — scaffold requests from a spec.</li>
                <li><b>Kubeconfigs vault</b> — encrypted at rest, decrypted on demand.</li>
                <li><b>CLI + desktop app</b> — same workspace format, run anywhere.</li>
              </ul>
              <p className="about-cta">
                <button className="link" onClick={() => openUrl(`https://github.com/${repo}`)}>
                  ★ Star on GitHub
                </button>
                {releaseUrl && (
                  <button className="link" onClick={() => openUrl(releaseUrl)}>
                    Release notes
                  </button>
                )}
                <button
                  className="link"
                  onClick={() => openUrl(`https://github.com/${repo}#readme`)}
                >
                  Read the docs
                </button>
              </p>
            </div>
          ) : (
            <div className="stargazers-pane">
              {loading && <div className="dim">Loading stargazers…</div>}
              {error && (
                <div className="dim">
                  Could not load stargazers ({error}). GitHub anonymous API limits
                  60 requests/hour per IP.
                </div>
              )}
              {users && users.length === 0 && !loading && (
                <div className="dim">No stargazers yet — be the first ★</div>
              )}
              {users && users.length > 0 && (
                <div className="stargazers-grid">
                  {users.map((u) => (
                    <button
                      key={u.login}
                      className="stargazer"
                      title={u.login}
                      onClick={() => openUrl(u.html_url)}
                    >
                      <img src={u.avatar_url} alt={u.login} loading="lazy" />
                      <span>{u.login}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
