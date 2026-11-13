//! Instructions for coding agents, written into a workspace so tools like
//! Claude Code, Codex or Cursor know how to read, write and run knock files.

use serde::Serialize;
use std::path::Path;

pub const AGENTS_MD: &str = r#"# Knock workspace — notes for coding agents

This folder is a [knock](https://github.com/jairoFernandez/knock) workspace: HTTP
requests, flows and environments stored as TOML and versioned with git.

## Prefer the tools over guessing

- MCP: if a `knock` MCP server is connected, use its tools (`knock_list`,
  `knock_run_request`, `knock_run_flow`, `knock_create_request`,
  `knock_import_curl`, ...). Register it with `claude mcp add knock -- knock mcp`.
- CLI (always available):
  - `knock list --json` — requests, flows and environments.
  - `knock run requests/<path>.toml --json` — send a request; `--dry-run` resolves without sending; `--fail` exits 1 on 4xx/5xx.
  - `knock flow <name> --json` — run `flows/<name>.toml`; exits 1 if an expectation fails.
  - `knock new <url> -X POST --name "Create user"` — create a request file.
  - `knock import curl '<curl command>'` — turn a curl into a request file.
  - `knock env use <name>` / `knock env show` — switch environment.
  - `knock mock serve` — serve the `[mock]` responses as a local API.

Output is redacted: tokens, passwords, cookies and values that only exist in
`environments/*.local.toml` show as `[redacted:<name>]`. Do not try to read or
print `*.local.toml` files, and never write secrets into tracked files —
reference them as `{{var}}` instead (`knock new` / `knock import curl` do this
for you).

## Layout

```
knock.toml                 workspace config (default_env, [mock])
requests/<folder>/<x>.toml one request per file; folder ≈ collection/host
flows/<name>.toml          ordered steps with expectations and captures
fragments/<name>.toml      reusable headers/query, pulled in with use = [...]
environments/<env>.toml    shared vars; <env>.local.toml (gitignored) replaces it locally
.knock/                    local state (active env, run history) — never commit
```

## Request file

```toml
name = "Create user"
method = "POST"
url = "{{base_url}}/users"
use = ["auth"]                 # fragments/auth.toml

[headers]
Accept = "application/json"

[query]
page = "1"

[path]                         # fills {{id}} in the url
id = "42"

[body.json]                    # or: [body] text = "...", [body.form], [body] file = "x.json"
name = "Ann"
```

Only one body kind per request. `{{var}}` resolves from the active environment.

## Flow file

```toml
name = "signup"

[[steps]]
name = "create"
request = "users/create"       # requests/users/create.toml
[steps.expect]
status = 201
body_contains = "id"
[steps.capture]
user_id = "id"                 # dot path into the JSON response, available as {{user_id}} next

[[steps]]
request = "users/get"
[steps.expect]
status = 200
```

## Verifying your changes

After changing an API, run the relevant request or flow and read the JSON:
`knock flow <name> --json` exits non-zero with the failed expectation and a body
excerpt, which is usually enough to fix the problem without asking the user.
"#;

pub const CLAUDE_MD: &str = "@AGENTS.md\n";

#[derive(Debug, Clone, Serialize)]
pub struct AgentDocs {
    pub written: Vec<String>,
    pub skipped: Vec<String>,
}

/// Writes AGENTS.md (and a CLAUDE.md that imports it) unless they already
/// exist. `force` refreshes AGENTS.md only; a user's CLAUDE.md is never touched.
pub fn write_agent_docs(root: &Path, force: bool) -> std::io::Result<AgentDocs> {
    let mut docs = AgentDocs {
        written: Vec::new(),
        skipped: Vec::new(),
    };
    for (name, content, overwritable) in [
        ("AGENTS.md", AGENTS_MD, force),
        ("CLAUDE.md", CLAUDE_MD, false),
    ] {
        let path = root.join(name);
        if path.exists() && !overwritable {
            docs.skipped.push(name.to_string());
            continue;
        }
        std::fs::write(&path, content)?;
        docs.written.push(name.to_string());
    }
    Ok(docs)
}
