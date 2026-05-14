use crate::workspace::Workspace;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct Finding {
    pub file: PathBuf,
    pub line: usize,
    pub kind: &'static str,
    pub snippet: String,
}

struct Pattern {
    kind: &'static str,
    regex: Regex,
}

fn patterns() -> &'static [Pattern] {
    static PATTERNS: OnceLock<Vec<Pattern>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let raw: &[(&str, &str)] = &[
            ("stripe", r"sk_(live|test)_[A-Za-z0-9]{16,}"),
            ("github_pat", r"ghp_[A-Za-z0-9]{36}"),
            ("github_fg_pat", r"github_pat_[A-Za-z0-9_]{82}"),
            ("slack_token", r"xox[baprs]-[A-Za-z0-9-]{10,}"),
            ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
            ("google_api_key", r"AIza[0-9A-Za-z\-_]{35}"),
            ("openai_key", r"sk-[A-Za-z0-9]{32,}"),
            ("bearer_literal", r"Bearer\s+[A-Za-z0-9_\-\.=]{20,}"),
            ("jwt", r"eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+"),
        ];
        raw.iter()
            .map(|(kind, pat)| Pattern {
                kind,
                regex: Regex::new(pat).expect("valid regex"),
            })
            .collect()
    })
}

pub fn scan_text(text: &str) -> Vec<(usize, &'static str, String)> {
    let mut findings = Vec::new();
    for (idx, line) in text.lines().enumerate() {
        for pattern in patterns() {
            for m in pattern.regex.find_iter(line) {
                let snippet = m.as_str();
                if snippet.contains("{{") {
                    continue;
                }
                findings.push((idx + 1, pattern.kind, snippet.to_string()));
            }
        }
    }
    findings
}

pub fn scan_workspace(workspace: &Workspace) -> std::io::Result<Vec<Finding>> {
    let mut files = Vec::new();
    walk(&workspace.root, &mut files)?;

    let mut findings = Vec::new();
    for file in files {
        let Ok(content) = std::fs::read_to_string(&file) else {
            continue;
        };
        for (line, kind, snippet) in scan_text(&content) {
            findings.push(Finding {
                file: file.clone(),
                line,
                kind,
                snippet,
            });
        }
    }
    Ok(findings)
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy().into_owned();
        if path.is_dir() {
            if matches!(
                name_str.as_str(),
                ".git" | ".knock" | "target" | "node_modules" | ".idea" | ".vscode"
            ) {
                continue;
            }
            walk(&path, files)?;
        } else if path.is_file() {
            if name_str.ends_with(".toml") && !name_str.ends_with(".local.toml") {
                files.push(path);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_stripe_key() {
        let findings = scan_text("token = \"sk_live_abcdef1234567890XYZ\"");
        assert!(findings.iter().any(|(_, k, _)| *k == "stripe"));
    }

    #[test]
    fn ignores_templated_bearer() {
        let findings = scan_text("Authorization = \"Bearer {{token}}\"");
        assert!(findings.is_empty(), "expected no findings, got {findings:?}");
    }

    #[test]
    fn detects_literal_bearer() {
        let findings =
            scan_text("Authorization = \"Bearer abcdef1234567890ABCDEFGHIJ\"");
        assert!(findings.iter().any(|(_, k, _)| *k == "bearer_literal"));
    }

    #[test]
    fn clean_text_yields_nothing() {
        let findings = scan_text("just some plain config\nname = \"hello\"");
        assert!(findings.is_empty());
    }
}
