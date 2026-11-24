//! Shell integration for the embedded terminal.
//!
//! zsh, bash and fish are started with small startup shims that load the
//! user's own config first and then emit OSC 133 marks (FinalTerm / iTerm2 /
//! VS Code / Warp convention):
//!
//! - `133;A` prompt starts, `133;B` prompt ends (input starts),
//! - `133;C` the command starts running, `133;D;<exit>` it finished.
//!
//! The frontend turns those marks into command blocks and uses the exact input
//! start for click-to-move. A shell that ignores the shims still works; it just
//! renders without blocks.

use std::path::{Path, PathBuf};

const ZSHENV: &str = r#"# Knock shell integration. Loads your own ~/.zshenv, then keeps ZDOTDIR here
# so zsh continues with Knock's .zprofile/.zshrc/.zlogin, which do the same.
KNOCK_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="${KNOCK_USER_ZDOTDIR:-$HOME}"
[[ -r "$ZDOTDIR/.zshenv" ]] && builtin source "$ZDOTDIR/.zshenv"
KNOCK_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
ZDOTDIR="$KNOCK_ZDOTDIR"
"#;

const ZPROFILE: &str = r#"ZDOTDIR="$KNOCK_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zprofile" ]] && builtin source "$ZDOTDIR/.zprofile"
KNOCK_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
ZDOTDIR="$KNOCK_ZDOTDIR"
"#;

const ZSHRC: &str = r#"ZDOTDIR="$KNOCK_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zshrc" ]] && builtin source "$ZDOTDIR/.zshrc"
KNOCK_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"
ZDOTDIR="$KNOCK_ZDOTDIR"
# /etc/zshrc derives HISTFILE from ZDOTDIR while it still points here.
if [[ "$HISTFILE" == "$KNOCK_ZDOTDIR"/* ]]; then
  HISTFILE="$KNOCK_USER_ZDOTDIR/.zsh_history"
fi
builtin source "$KNOCK_ZDOTDIR/knock-integration.zsh"
if [[ ! -o login ]]; then
  ZDOTDIR="$KNOCK_USER_ZDOTDIR"
  builtin unset KNOCK_USER_ZDOTDIR KNOCK_ZDOTDIR
fi
"#;

const ZLOGIN: &str = r#"ZDOTDIR="$KNOCK_USER_ZDOTDIR"
[[ -r "$ZDOTDIR/.zlogin" ]] && builtin source "$ZDOTDIR/.zlogin"
builtin unset KNOCK_USER_ZDOTDIR KNOCK_ZDOTDIR
"#;

const ZSH_HOOKS: &str = r#"[[ -n "$__knock_si_loaded" ]] && return
typeset -g __knock_si_loaded=1
typeset -g __knock_si_running=0
autoload -Uz add-zsh-hook

__knock_si_precmd() {
  local ec=$?
  if (( __knock_si_running )); then
    builtin printf '\e]133;D;%s\a' "$ec"
  fi
  __knock_si_running=0
  # Themes rebuild PS1 in their own precmd hooks, which run before this one.
  if [[ "$PS1" != *$'\e]133;B'* ]]; then
    PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
  fi
}

__knock_si_preexec() {
  __knock_si_running=1
  builtin printf '\e]133;C\a'
}

add-zsh-hook precmd __knock_si_precmd
add-zsh-hook preexec __knock_si_preexec
"#;

const BASH_RC: &str = r#"# Knock shell integration. Started with --init-file, so emulate the startup
# files bash would have read on its own.
if [ -n "$KNOCK_BASH_LOGIN" ]; then
  builtin unset KNOCK_BASH_LOGIN
  [ -r /etc/profile ] && builtin source /etc/profile
  if [ -r "$HOME/.bash_profile" ]; then builtin source "$HOME/.bash_profile"
  elif [ -r "$HOME/.bash_login" ]; then builtin source "$HOME/.bash_login"
  elif [ -r "$HOME/.profile" ]; then builtin source "$HOME/.profile"
  fi
else
  [ -r "$HOME/.bashrc" ] && builtin source "$HOME/.bashrc"
fi

if [ -z "$__knock_si_loaded" ]; then
  __knock_si_loaded=1
  __knock_si_running=
  __knock_si_armed=

  __knock_si_status() {
    local ec=$?
    __knock_si_armed=
    if [ -n "$__knock_si_running" ]; then
      builtin printf '\033]133;D;%s\007' "$ec"
    fi
    __knock_si_running=
    return $ec
  }

  __knock_si_prompt() {
    local ec=$?
    case "$PS1" in
      *'133;B'*) ;;
      *) PS1='\[\033]133;A\007\]'"$PS1"'\[\033]133;B\007\]' ;;
    esac
    __knock_si_armed=1
    return $ec
  }

  __knock_si_preexec() {
    [ -n "$__knock_si_armed" ] || return 0
    case "$BASH_COMMAND" in __knock_si_*) return 0 ;; esac
    __knock_si_armed=
    __knock_si_running=1
    builtin printf '\033]133;C\007'
  }

  case "$(declare -p PROMPT_COMMAND 2>/dev/null)" in
    'declare -a'*)
      PROMPT_COMMAND=(__knock_si_status "${PROMPT_COMMAND[@]}" __knock_si_prompt)
      ;;
    *)
      __knock_si_pc=$PROMPT_COMMAND
      # A trailing ';' would make the joined command a syntax error.
      while :; do
        case "$__knock_si_pc" in
          *';' | *' ') __knock_si_pc=${__knock_si_pc%?} ;;
          *) break ;;
        esac
      done
      PROMPT_COMMAND="__knock_si_status${__knock_si_pc:+;$__knock_si_pc};__knock_si_prompt"
      builtin unset __knock_si_pc
      ;;
  esac
  # Leave an existing DEBUG trap (bash-preexec and friends) alone; blocks then
  # just lack the running/exit marks.
  if [ -z "$(trap -p DEBUG)" ]; then
    trap '__knock_si_preexec' DEBUG
  fi
fi
"#;

const FISH_HOOKS: &str = r#"# Knock shell integration. fish 4 emits these marks itself.
if not set -q __knock_si_loaded; and not string match -qr '^[4-9]' -- $version
  set -g __knock_si_loaded 1

  function __knock_si_preexec --on-event fish_preexec
    set -g __knock_si_running 1
    printf '\e]133;C\a'
  end

  function __knock_si_postexec --on-event fish_postexec
    set -g __knock_si_status $status
  end

  function __knock_si_prompt --on-event fish_prompt
    if set -q __knock_si_running
      printf '\e]133;D;%s\a' $__knock_si_status
      set -e __knock_si_running
    end
  end

  function __knock_si_return
    return $argv[1]
  end

  if functions -q fish_prompt
    functions -c fish_prompt __knock_si_user_prompt
    function fish_prompt
      set -l s $status
      printf '\e]133;A\a'
      __knock_si_return $s
      __knock_si_user_prompt
      printf '\e]133;B\a'
    end
  end
end
"#;

/// Which integration a shell program gets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Zsh,
    Bash,
    Fish,
    Other,
}

pub fn shell_kind(program: &str) -> ShellKind {
    let base = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let base = base.strip_suffix(".exe").unwrap_or(base);
    match base {
        "zsh" => ShellKind::Zsh,
        "bash" => ShellKind::Bash,
        "fish" => ShellKind::Fish,
        _ => ShellKind::Other,
    }
}

/// Arguments and environment to start `program` with integration loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Rewrite a shell launch so it loads the shims in `dir`.
///
/// `user_zdotdir` is the ZDOTDIR the app itself was started with, if any; the
/// shims load the user's files from there (or `$HOME`).
pub fn prepare(program: &str, args: Vec<String>, dir: &Path, user_zdotdir: Option<&str>) -> Launch {
    match shell_kind(program) {
        ShellKind::Zsh => {
            let mut env = vec![(
                "ZDOTDIR".to_string(),
                dir.join("zsh").to_string_lossy().to_string(),
            )];
            if let Some(z) = user_zdotdir.filter(|z| !z.is_empty()) {
                env.push(("KNOCK_USER_ZDOTDIR".to_string(), z.to_string()));
            }
            Launch { args, env }
        }
        ShellKind::Bash => {
            // --init-file is ignored by login shells, so the shim emulates the
            // login startup files instead of passing -l.
            let login = args.iter().any(|a| a == "-l" || a == "--login");
            let mut out: Vec<String> = args
                .into_iter()
                .filter(|a| a != "-l" && a != "--login")
                .collect();
            out.push("--init-file".to_string());
            out.push(dir.join("bash").join("knock.bash").to_string_lossy().to_string());
            let env = if login {
                vec![("KNOCK_BASH_LOGIN".to_string(), "1".to_string())]
            } else {
                vec![]
            };
            Launch { args: out, env }
        }
        ShellKind::Fish => {
            let mut out = args;
            let file = dir.join("fish").join("knock.fish");
            out.push("--init-command".to_string());
            out.push(format!("source {}", fish_quote(&file.to_string_lossy())));
            Launch { args: out, env: vec![] }
        }
        ShellKind::Other => Launch { args, env: vec![] },
    }
}

fn fish_quote(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn files() -> [(&'static str, &'static str); 7] {
    [
        ("zsh/.zshenv", ZSHENV),
        ("zsh/.zprofile", ZPROFILE),
        ("zsh/.zshrc", ZSHRC),
        ("zsh/.zlogin", ZLOGIN),
        ("zsh/knock-integration.zsh", ZSH_HOOKS),
        ("bash/knock.bash", BASH_RC),
        ("fish/knock.fish", FISH_HOOKS),
    ]
}

/// Write the shims under `dir`, skipping files that are already current.
pub fn install(dir: &Path) -> std::io::Result<()> {
    for (rel, body) in files() {
        let path = dir.join(rel);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(body) {
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, body)?;
    }
    Ok(())
}

/// Where the shims live. Disabled with `KNOCK_SHELL_INTEGRATION=0`.
pub fn integration_dir() -> Option<PathBuf> {
    // Windows shells (PowerShell, cmd, Git Bash, WSL) are left as they are.
    if cfg!(windows) {
        return None;
    }
    if std::env::var("KNOCK_SHELL_INTEGRATION").ok().as_deref() == Some("0") {
        return None;
    }
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    Some(base.join("knock").join("shell-integration"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn detects_shells_by_basename() {
        assert_eq!(shell_kind("/bin/zsh"), ShellKind::Zsh);
        assert_eq!(shell_kind("bash"), ShellKind::Bash);
        assert_eq!(shell_kind("/opt/homebrew/bin/fish"), ShellKind::Fish);
        assert_eq!(shell_kind("C:\\Git\\bin\\bash.exe"), ShellKind::Bash);
        assert_eq!(shell_kind("/bin/sh"), ShellKind::Other);
        assert_eq!(shell_kind("pwsh.exe"), ShellKind::Other);
    }

    #[test]
    fn zsh_points_zdotdir_at_the_shims_and_keeps_args() {
        let dir = Path::new("/c/si");
        let l = prepare("/bin/zsh", s(&["-l"]), dir, Some("/home/u/.config/zsh"));
        assert_eq!(l.args, s(&["-l"]));
        assert!(l.env.contains(&("ZDOTDIR".into(), "/c/si/zsh".into())));
        assert!(l.env.contains(&("KNOCK_USER_ZDOTDIR".into(), "/home/u/.config/zsh".into())));
        let l = prepare("zsh", s(&["-l"]), dir, None);
        assert_eq!(l.env.len(), 1);
    }

    #[test]
    fn bash_trades_login_flag_for_init_file() {
        let l = prepare("/bin/bash", s(&["-l"]), Path::new("/c/si"), None);
        assert_eq!(l.args, s(&["--init-file", "/c/si/bash/knock.bash"]));
        assert_eq!(l.env, vec![("KNOCK_BASH_LOGIN".to_string(), "1".to_string())]);
        let l = prepare("bash", vec![], Path::new("/c/si"), None);
        assert!(l.env.is_empty());
    }

    #[test]
    fn fish_sources_the_shim_after_its_config() {
        let l = prepare("fish", s(&["-l"]), Path::new("/c/it's"), None);
        assert_eq!(l.args[0], "-l");
        assert_eq!(l.args[1], "--init-command");
        assert_eq!(l.args[2], "source '/c/it\\'s/fish/knock.fish'");
    }

    #[test]
    fn other_shells_are_untouched() {
        let l = prepare("/bin/sh", s(&["-i"]), Path::new("/x"), None);
        assert_eq!(l, Launch { args: s(&["-i"]), env: vec![] });
    }

    #[test]
    fn shims_emit_all_four_marks() {
        for body in [ZSH_HOOKS, BASH_RC, FISH_HOOKS] {
            for mark in ["133;A", "133;B", "133;C", "133;D"] {
                assert!(body.contains(mark), "missing {mark}");
            }
        }
    }

    #[test]
    fn zsh_shims_load_each_user_startup_file() {
        assert!(ZSHENV.contains("/.zshenv"));
        assert!(ZPROFILE.contains("/.zprofile"));
        assert!(ZSHRC.contains("/.zshrc") && ZSHRC.contains("knock-integration.zsh"));
        assert!(ZLOGIN.contains("/.zlogin"));
    }

    #[test]
    fn install_writes_and_refreshes_files() {
        let dir = std::env::temp_dir().join(format!("knock-si-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        install(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("zsh/.zshrc")).unwrap(), ZSHRC);
        std::fs::write(dir.join("bash/knock.bash"), "stale").unwrap();
        install(&dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("bash/knock.bash")).unwrap(), BASH_RC);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
