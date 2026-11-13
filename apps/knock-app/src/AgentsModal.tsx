import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  workspaceRoot: string | null;
  onClose: () => void;
}

interface AgentsStatus {
  knockPath: string | null;
  claudePath: string | null;
  mcpRegistered: boolean | null;
  agentsMd: boolean;
}

type Agent = "claude" | "codex" | "cursor";

const BREW_CLI = "brew install jairofernandez/knock/knock";
const SCRIPT_CLI =
  "curl -fsSL https://raw.githubusercontent.com/jairoFernandez/knock/main/scripts/install.sh | bash";
const CLAUDE_CMD = "claude mcp add --scope user knock -- knock mcp";
const CODEX_CMD = "codex mcp add knock -- knock mcp";
const CURSOR_JSON = `{
  "mcpServers": {
    "knock": { "command": "knock", "args": ["mcp"] }
  }
}`;
const EXAMPLE_PROMPT =
  "Use knock to run the signup flow against local. If a step fails, find the cause in the code, fix it and run the flow again until it passes.";

function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="agents-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="agents-snippet">
      <pre>{text}</pre>
      <Copy text={text} />
    </div>
  );
}

function Mark({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="agents-mark unknown">?</span>;
  return <span className={`agents-mark ${ok ? "ok" : "todo"}`}>{ok ? "✓" : "•"}</span>;
}

export function AgentsModal({ workspaceRoot, onClose }: Props) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [agent, setAgent] = useState<Agent>("claude");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await invoke<AgentsStatus>("agents_status", { root: workspaceRoot }));
    } finally {
      setChecking(false);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function registerClaude() {
    setBusy(true);
    setMessage(null);
    try {
      const out = await invoke<string>("agents_register_claude");
      setMessage({ ok: true, text: out || "Registered." });
      await refresh();
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function writeDocs() {
    if (!workspaceRoot) return;
    setBusy(true);
    setMessage(null);
    try {
      const written = await invoke<string[]>("agents_write_docs", { root: workspaceRoot });
      setMessage({
        ok: true,
        text: written.length > 0 ? `Wrote ${written.join(" and ")}.` : "Files already existed — left untouched.",
      });
      await refresh();
    } catch (e) {
      setMessage({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const hasCli = status ? status.knockPath !== null : null;
  const hasClaude = status ? status.claudePath !== null : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about-modal agents-modal" onClick={(e) => e.stopPropagation()}>
        <div className="about-header">
          <div className="about-brand">
            <div className="about-logo">✦</div>
            <div>
              <h2>Use Knock from AI agents</h2>
              <div className="about-sub">
                Let Claude Code, Codex or Cursor run and verify your API — without seeing your secrets
              </div>
            </div>
          </div>
          <button className="about-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="about-body agents-body">
          <p className="agents-intro">
            Your agent gets tools to list, run and create requests and to run flows. It can check the
            API it just changed and fix what fails. Tokens, cookies and values from{" "}
            <code>*.local.toml</code> always come back as <code>[redacted:name]</code>, and every run
            shows up in this app's history.
          </p>

          <ol className="agents-steps">
            <li>
              <div className="agents-step-title">
                <Mark ok={hasCli} /> Install the <code>knock</code> CLI
              </div>
              {hasCli ? (
                <div className="agents-found">Found at <code>{status?.knockPath}</code></div>
              ) : (
                <>
                  <div className="agents-hint">With Homebrew (macOS / Linux):</div>
                  <Snippet text={BREW_CLI} />
                  <div className="agents-hint">Or with the install script:</div>
                  <Snippet text={SCRIPT_CLI} />
                </>
              )}
            </li>

            <li>
              <div className="agents-step-title">
                <Mark ok={agent === "claude" ? (status ? status.mcpRegistered : null) : null} /> Connect
                your agent
              </div>
              <div className="agents-agent-tabs">
                {(["claude", "codex", "cursor"] as Agent[]).map((a) => (
                  <button
                    key={a}
                    className={agent === a ? "active" : ""}
                    onClick={() => setAgent(a)}
                  >
                    {a === "claude" ? "Claude Code" : a === "codex" ? "Codex" : "Cursor / others"}
                  </button>
                ))}
              </div>
              {agent === "claude" && (
                <>
                  {status?.mcpRegistered ? (
                    <div className="agents-found">
                      Connected. Open Claude Code in a folder that contains a Knock workspace and ask
                      it to use knock.
                    </div>
                  ) : (
                    <>
                      <div className="agents-actions">
                        <button
                          className="primary"
                          disabled={busy || !hasCli || !hasClaude}
                          onClick={registerClaude}
                          title={
                            !hasClaude
                              ? "Claude Code (claude) not found"
                              : !hasCli
                                ? "Install the knock CLI first"
                                : "Runs the command below for you"
                          }
                        >
                          {busy ? "Working…" : "Add to Claude Code"}
                        </button>
                        {hasClaude === false && (
                          <span className="agents-hint">
                            Claude Code not found — install it, or run the command yourself.
                          </span>
                        )}
                      </div>
                      <div className="agents-hint">Or run it in a terminal:</div>
                      <Snippet text={CLAUDE_CMD} />
                      <div className="agents-hint">
                        Using <code>CLAUDE_CONFIG_DIR</code> profiles? Run the command from a terminal
                        with that profile active — the button uses the default one.
                      </div>
                    </>
                  )}
                </>
              )}
              {agent === "codex" && <Snippet text={CODEX_CMD} />}
              {agent === "cursor" && (
                <>
                  <div className="agents-hint">
                    Add this to the MCP config (Cursor: <code>~/.cursor/mcp.json</code>; Claude Desktop,
                    Windsurf and others use the same shape):
                  </div>
                  <Snippet text={CURSOR_JSON} />
                </>
              )}
            </li>

            <li>
              <div className="agents-step-title">
                <Mark ok={workspaceRoot ? (status ? status.agentsMd : null) : null} /> Teach agents this
                workspace
              </div>
              <div className="agents-hint">
                Writes <code>AGENTS.md</code> (file format, commands, rules about secrets) and a{" "}
                <code>CLAUDE.md</code> that imports it. Existing files are never overwritten.
              </div>
              <div className="agents-actions">
                <button
                  disabled={busy || !workspaceRoot || status?.agentsMd === true}
                  onClick={writeDocs}
                >
                  {status?.agentsMd ? "AGENTS.md present" : "Write AGENTS.md"}
                </button>
                {!workspaceRoot && <span className="agents-hint">Open a workspace first.</span>}
              </div>
            </li>
          </ol>

          {message && (
            <div className={`agents-message ${message.ok ? "ok" : "error"}`}>{message.text}</div>
          )}

          <div className="agents-try">
            <div className="agents-step-title">Try it — paste into your agent</div>
            <Snippet text={EXAMPLE_PROMPT} />
          </div>

          <div className="agents-footer">
            <button className="link" onClick={() => void refresh()} disabled={checking}>
              {checking ? "Checking…" : "Re-check"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
