import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConfirmOptions } from "./ConfirmDialog";
import {
  filterNotes,
  listContinuation,
  noteStats,
  relativeTime,
  toggleTask,
  uniqueName,
  validateNoteName,
  type NoteMeta,
  type NoteScope,
} from "./notesModel";
import { markdownToHtml } from "./notesMarkdown";

interface Props {
  /** Open workspace, if any: enables the per-workspace section. */
  workspaceRoot: string | null;
  workspaceName?: string;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

interface Selection {
  scope: NoteScope;
  name: string;
}

type Layout = "edit" | "split" | "preview";
type SaveState = "saved" | "dirty" | "saving" | "error";
type PassDialog = { kind: "encrypt" } | { kind: "change" } | null;

const AUTOSAVE_MS = 700;
const MIN_PASSPHRASE = 8;

const keyOf = (s: Selection) => `${s.scope}\u0000${s.name}`;

function renderMarkdown(src: string): string {
  const html = markdownToHtml(src);
  // Task checkboxes come out disabled, and disabled inputs get no clicks:
  // enable them so they can be ticked from the preview (see onPreviewClick).
  return DOMPurify.sanitize(html).replace(/<input ([^>]*?)disabled="" ([^>]*?type="checkbox")/g, "<input $1$2");
}

function errText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

const LOCK_ICON = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

export function NotesView({ workspaceRoot, workspaceName, confirm }: Props) {
  const [lists, setLists] = useState<Record<NoteScope, NoteMeta[]>>({ global: [], workspace: [] });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [content, setContent] = useState("");
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unlockPass, setUnlockPass] = useState("");
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  // Every note opens in preview: secrets stay masked until you choose to edit,
  // so nothing leaks while sharing the screen.
  const [layout, setLayout] = useState<Layout>("preview");
  const [nameDraft, setNameDraft] = useState("");
  const [passDialog, setPassDialog] = useState<PassDialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Passphrases of notes unlocked in this session. Never persisted; dropped on
  // Lock and when the view unmounts.
  const passes = useRef(new Map<string, string>());
  const savedRef = useRef("");
  const contentRef = useRef("");
  const selectedRef = useRef<Selection | null>(null);
  const lockedRef = useRef(false);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const syncingScroll = useRef(false);

  contentRef.current = content;
  selectedRef.current = selected;
  lockedRef.current = locked;

  const rootArg = useCallback(
    (scope: NoteScope) => (scope === "workspace" ? workspaceRoot : null),
    [workspaceRoot],
  );

  const refresh = useCallback(
    async (scope: NoteScope) => {
      if (scope === "workspace" && !workspaceRoot) {
        setLists((l) => ({ ...l, workspace: [] }));
        return;
      }
      try {
        const notes = await invoke<NoteMeta[]>("notes_list", { scope, root: rootArg(scope) });
        setLists((l) => ({ ...l, [scope]: notes }));
      } catch (e) {
        setError(errText(e));
      }
    },
    [rootArg, workspaceRoot],
  );

  useEffect(() => {
    void refresh("global");
  }, [refresh]);

  useEffect(() => {
    void refresh("workspace");
    if (selectedRef.current?.scope === "workspace") {
      setSelected(null);
      setContent("");
    }
  }, [refresh, workspaceRoot]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    const p = passes.current;
    return () => {
      window.clearInterval(id);
      p.clear();
    };
  }, []);

  /** Write the open note if it changed. Saves run one at a time. */
  const flush = useCallback((): Promise<void> => {
    const run = async () => {
      const sel = selectedRef.current;
      if (!sel || lockedRef.current) return;
      const snapshot = contentRef.current;
      if (snapshot === savedRef.current) return;
      setSaveState("saving");
      try {
        const meta = await invoke<NoteMeta>("notes_save", {
          scope: sel.scope,
          root: rootArg(sel.scope),
          name: sel.name,
          content: snapshot,
          passphrase: passes.current.get(keyOf(sel)) ?? null,
        });
        savedRef.current = snapshot;
        setLists((l) => ({
          ...l,
          [sel.scope]: [meta, ...l[sel.scope].filter((n) => n.name !== sel.name)],
        }));
        setSaveState(contentRef.current === snapshot ? "saved" : "dirty");
      } catch (e) {
        setSaveState("error");
        setError(errText(e));
      }
    };
    saveChain.current = saveChain.current.then(run, run);
    return saveChain.current;
  }, [rootArg]);

  useEffect(() => {
    if (!selected || locked || content === savedRef.current) return;
    setSaveState("dirty");
    const t = window.setTimeout(() => void flush(), AUTOSAVE_MS);
    return () => window.clearTimeout(t);
  }, [content, selected, locked, flush]);

  // Last chance to save when the view goes away.
  useEffect(() => () => void flush(), [flush]);

  const load = useCallback(
    async (sel: Selection, encrypted: boolean) => {
      const pass = passes.current.get(keyOf(sel));
      setError(null);
      setUnlockError(null);
      setUnlockPass("");
      if (encrypted && !pass) {
        savedRef.current = "";
        setContent("");
        setLocked(true);
        return;
      }
      setLoading(true);
      try {
        const text = await invoke<string>("notes_read", {
          scope: sel.scope,
          root: rootArg(sel.scope),
          name: sel.name,
          passphrase: pass ?? null,
        });
        savedRef.current = text;
        setContent(text);
        setLocked(false);
        setSaveState("saved");
      } catch (e) {
        setError(errText(e));
      } finally {
        setLoading(false);
      }
    },
    [rootArg],
  );

  async function open(sel: Selection, encrypted: boolean, initialLayout: Layout = "preview") {
    const cur = selectedRef.current;
    if (cur && keyOf(cur) === keyOf(sel)) return;
    await flush();
    setMenuOpen(false);
    setLayout(initialLayout);
    setSelected(sel);
    setNameDraft(sel.name);
    await load(sel, encrypted);
  }

  async function createNote(scope: NoteScope) {
    const name = uniqueName("Untitled", lists[scope].map((n) => n.name));
    try {
      const meta = await invoke<NoteMeta>("notes_create", { scope, root: rootArg(scope), name });
      setLists((l) => ({ ...l, [scope]: [meta, ...l[scope]] }));
      await open({ scope, name }, false, "split");
      window.setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>(".notes-title-input");
        input?.focus();
        input?.select();
      }, 0);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function unlock() {
    const sel = selectedRef.current;
    if (!sel || !unlockPass) return;
    setLoading(true);
    setUnlockError(null);
    try {
      const text = await invoke<string>("notes_read", {
        scope: sel.scope,
        root: rootArg(sel.scope),
        name: sel.name,
        passphrase: unlockPass,
      });
      passes.current.set(keyOf(sel), unlockPass);
      savedRef.current = text;
      setContent(text);
      setLocked(false);
      setUnlockPass("");
      setSaveState("saved");
    } catch (e) {
      const msg = errText(e);
      setUnlockError(msg.includes("decryption failed") ? "Wrong passphrase" : msg);
    } finally {
      setLoading(false);
    }
  }

  async function lockNote() {
    const sel = selectedRef.current;
    if (!sel) return;
    await flush();
    passes.current.delete(keyOf(sel));
    savedRef.current = "";
    setContent("");
    setLocked(true);
    setLayout("preview");
    setMenuOpen(false);
  }

  /** Re-save the open note with a new passphrase (or none). */
  async function setEncryption(pass: string | null) {
    const sel = selectedRef.current;
    if (!sel) return;
    await saveChain.current;
    setSaveState("saving");
    try {
      const meta = await invoke<NoteMeta>("notes_save", {
        scope: sel.scope,
        root: rootArg(sel.scope),
        name: sel.name,
        content: contentRef.current,
        passphrase: pass,
      });
      if (pass) passes.current.set(keyOf(sel), pass);
      else passes.current.delete(keyOf(sel));
      savedRef.current = contentRef.current;
      setLists((l) => ({
        ...l,
        [sel.scope]: [meta, ...l[sel.scope].filter((n) => n.name !== sel.name)],
      }));
      setSaveState("saved");
    } catch (e) {
      setSaveState("error");
      setError(errText(e));
    }
  }

  async function removeEncryption() {
    setMenuOpen(false);
    const ok = await confirm({
      title: "Remove encryption",
      message: "The note will be stored as plain text on disk. Anyone with access to the file can read it.",
      confirmLabel: "Remove encryption",
    });
    if (ok) await setEncryption(null);
  }

  async function commitRename() {
    const sel = selectedRef.current;
    const to = nameDraft.trim();
    if (!sel || to === sel.name) {
      setNameDraft(sel?.name ?? "");
      return;
    }
    const invalid = validateNoteName(to);
    if (invalid) {
      setError(invalid);
      setNameDraft(sel.name);
      return;
    }
    await flush();
    try {
      const meta = await invoke<NoteMeta>("notes_rename", {
        scope: sel.scope,
        root: rootArg(sel.scope),
        from: sel.name,
        to,
      });
      const pass = passes.current.get(keyOf(sel));
      passes.current.delete(keyOf(sel));
      const next = { scope: sel.scope, name: meta.name };
      if (pass) passes.current.set(keyOf(next), pass);
      setLists((l) => ({
        ...l,
        [sel.scope]: [meta, ...l[sel.scope].filter((n) => n.name !== sel.name)],
      }));
      setSelected(next);
      setNameDraft(meta.name);
      setError(null);
    } catch (e) {
      setError(errText(e));
      setNameDraft(sel.name);
    }
  }

  async function deleteNote() {
    const sel = selectedRef.current;
    if (!sel) return;
    setMenuOpen(false);
    const ok = await confirm({
      title: "Delete note",
      message: `Delete "${sel.name}"? This cannot be undone.`,
    });
    if (!ok) return;
    // A save still in flight would recreate the file after it is removed.
    await saveChain.current;
    try {
      await invoke("notes_remove", { scope: sel.scope, root: rootArg(sel.scope), name: sel.name });
      passes.current.delete(keyOf(sel));
      savedRef.current = "";
      setSelected(null);
      setContent("");
      setLocked(false);
      setLists((l) => ({ ...l, [sel.scope]: l[sel.scope].filter((n) => n.name !== sel.name) }));
    } catch (e) {
      setError(errText(e));
    }
  }

  const selectedMeta = selected
    ? lists[selected.scope].find((n) => n.name === selected.name) ?? null
    : null;
  const encrypted = selectedMeta?.encrypted ?? false;

  const html = useMemo(() => (layout === "edit" || locked ? "" : renderMarkdown(content)), [content, layout, locked]);
  const stats = useMemo(() => noteStats(content), [content]);

  function onEditorKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void flush();
      return;
    }
    if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value } = ta;
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      if (e.shiftKey) {
        const line = value.slice(lineStart);
        const strip = line.startsWith("  ") ? 2 : line.startsWith(" ") ? 1 : 0;
        if (!strip) return;
        ta.setRangeText("", lineStart, lineStart + strip, "preserve");
        ta.setSelectionRange(Math.max(lineStart, s - strip), Math.max(lineStart, end - strip));
      } else if (s === end) {
        ta.setRangeText("  ", s, end, "end");
      } else {
        ta.setRangeText("  ", lineStart, lineStart, "preserve");
        ta.setSelectionRange(s + 2, end + 2);
      }
      setContent(ta.value);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
      const { selectionStart: s, selectionEnd: end, value } = ta;
      if (s !== end) return;
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const lineEnd = value.indexOf("\n", s);
      if (lineEnd !== -1 && lineEnd !== s) return;
      const cont = listContinuation(value.slice(lineStart, s));
      if (!cont) return;
      e.preventDefault();
      if ("clear" in cont) {
        ta.setRangeText("", lineStart, s, "end");
      } else {
        ta.setRangeText(`\n${cont.prefix}`, s, s, "end");
      }
      setContent(ta.value);
    }
  }

  function flashLabel(btn: HTMLElement, text: string) {
    const original = btn.dataset.label ?? btn.textContent ?? "";
    btn.dataset.label = original;
    btn.textContent = text;
    window.setTimeout(() => {
      if (btn.isConnected) btn.textContent = original;
    }, 1200);
  }

  async function copyText(btn: HTMLElement, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      flashLabel(btn, "Copied");
    } catch {
      flashLabel(btn, "Failed");
    }
  }

  function onPreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const secretBtn = target.closest<HTMLElement>("[data-secret-action]");
    if (secretBtn) {
      e.preventDefault();
      const secret = secretBtn.closest<HTMLElement>(".note-secret");
      const value = secret?.querySelector(".note-secret-value")?.textContent ?? "";
      if (secretBtn.dataset.secretAction === "copy") {
        void copyText(secretBtn, value);
      } else if (secret) {
        const revealed = secret.classList.toggle("revealed");
        secretBtn.textContent = revealed ? "Hide" : "Show";
      }
      return;
    }
    const codeBtn = target.closest<HTMLElement>("[data-code-action]");
    if (codeBtn) {
      e.preventDefault();
      const code = codeBtn.closest(".note-code")?.querySelector("pre code")?.textContent ?? "";
      void copyText(codeBtn, code.replace(/\n$/, ""));
      return;
    }
    if (target instanceof HTMLInputElement && target.type === "checkbox") {
      e.preventDefault();
      const boxes = Array.from(previewRef.current?.querySelectorAll('input[type="checkbox"]') ?? []);
      const idx = boxes.indexOf(target);
      if (idx >= 0) setContent((c) => toggleTask(c, idx));
      return;
    }
    const link = target.closest("a");
    if (link) {
      e.preventDefault();
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        const id = decodeURIComponent(href.slice(1));
        previewRef.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "start" });
      } else if (/^(https?:|mailto:)/i.test(href)) {
        invoke("open_url", { url: href }).catch(() => undefined);
      }
    }
  }

  function syncScroll(from: HTMLElement | null, to: HTMLElement | null) {
    if (!from || !to || layout !== "split") return;
    if (syncingScroll.current) {
      syncingScroll.current = false;
      return;
    }
    const max = from.scrollHeight - from.clientHeight;
    const ratio = max > 0 ? from.scrollTop / max : 0;
    syncingScroll.current = true;
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
  }

  function renderSection(scope: NoteScope, title: string) {
    const notes = filterNotes(lists[scope], query);
    return (
      <div className="notes-section">
        <div className="notes-section-header">
          <span className="notes-section-title" title={scope === "workspace" ? workspaceRoot ?? "" : undefined}>
            {title}
          </span>
          <button className="notes-icon-btn" title={`New ${scope} note`} onClick={() => void createNote(scope)}>
            +
          </button>
        </div>
        {notes.length === 0 && (
          <div className="notes-empty-list">{query ? "No matches" : "No notes yet"}</div>
        )}
        {notes.map((n) => {
          const active = selected?.scope === scope && selected.name === n.name;
          return (
            <button
              key={n.name}
              className={`notes-item${active ? " active" : ""}`}
              onClick={() => void open({ scope, name: n.name }, n.encrypted)}
              title={n.name}
            >
              <span className="notes-item-name">{n.name}</span>
              {n.encrypted && <span className="notes-item-lock">{LOCK_ICON}</span>}
              <span className="notes-item-time">{relativeTime(n.modified, now)}</span>
            </button>
          );
        })}
      </div>
    );
  }

  const statusLabel =
    saveState === "saving" ? "Saving…" : saveState === "dirty" ? "Unsaved" : saveState === "error" ? "Save failed" : "Saved";

  return (
    <div className="notes-view">
      <aside className="notes-sidebar">
        <div className="panel-header">Notes</div>
        <div className="notes-search">
          <input
            className="kube-input"
            placeholder="Search notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="notes-sections">
          {renderSection("global", "Global")}
          {workspaceRoot && renderSection("workspace", workspaceName || "Workspace")}
        </div>
      </aside>

      <section className="notes-main">
        {!selected && (
          <div className="notes-placeholder">
            <div>Markdown notes, stored locally. Encrypt the ones that hold secrets.</div>
            <div className="notes-placeholder-actions">
              <button className="primary" onClick={() => void createNote("global")}>
                New global note
              </button>
              {workspaceRoot && (
                <button onClick={() => void createNote("workspace")}>New workspace note</button>
              )}
            </div>
          </div>
        )}

        {selected && (
          <>
            <div className="notes-header">
              <input
                className="notes-title-input"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setNameDraft(selected.name);
                    window.setTimeout(() => editorRef.current?.focus(), 0);
                  }
                }}
                spellCheck={false}
              />
              <span className={`notes-badge${encrypted ? " encrypted" : ""}`}>
                {encrypted ? (
                  <>
                    {LOCK_ICON} Encrypted
                  </>
                ) : (
                  "Plain text"
                )}
              </span>
              <span className="notes-scope">{selected.scope === "global" ? "Global" : workspaceName || "Workspace"}</span>
              <div className="notes-header-spacer" />
              <div className="notes-segmented" role="tablist">
                {(["edit", "split", "preview"] as Layout[]).map((l) => (
                  <button
                    key={l}
                    className={layout === l ? "active" : ""}
                    onClick={() => setLayout(l)}
                    disabled={locked}
                  >
                    {l === "edit" ? "Edit" : l === "split" ? "Split" : "Preview"}
                  </button>
                ))}
              </div>
              <div className="notes-menu-wrap">
                <button className="notes-icon-btn" title="Note actions" onClick={() => setMenuOpen((o) => !o)}>
                  ⋯
                </button>
                {menuOpen && (
                  <>
                    <div className="notes-menu-backdrop" onClick={() => setMenuOpen(false)} />
                    <div className="notes-menu">
                      {!encrypted && (
                        <button
                          onClick={() => {
                            setMenuOpen(false);
                            setPassDialog({ kind: "encrypt" });
                          }}
                        >
                          Encrypt…
                        </button>
                      )}
                      {encrypted && !locked && (
                        <>
                          <button onClick={() => void lockNote()}>Lock now</button>
                          <button
                            onClick={() => {
                              setMenuOpen(false);
                              setPassDialog({ kind: "change" });
                            }}
                          >
                            Change passphrase…
                          </button>
                          <button onClick={() => void removeEncryption()}>Remove encryption…</button>
                        </>
                      )}
                      <button className="danger-item" onClick={() => void deleteNote()}>
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {error && (
              <div className="notes-error" onClick={() => setError(null)}>
                {error}
              </div>
            )}

            {locked ? (
              <div className="notes-locked">
                <div className="notes-locked-icon">{LOCK_ICON}</div>
                <div className="notes-locked-title">This note is encrypted</div>
                <form
                  className="notes-unlock"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void unlock();
                  }}
                >
                  <input
                    className="kube-input"
                    type="password"
                    placeholder="Passphrase"
                    value={unlockPass}
                    autoFocus
                    onChange={(e) => setUnlockPass(e.target.value)}
                  />
                  <button className="primary" type="submit" disabled={!unlockPass || loading}>
                    {loading ? "Unlocking…" : "Unlock"}
                  </button>
                </form>
                {unlockError && <div className="notes-unlock-error">{unlockError}</div>}
              </div>
            ) : (
              <div className={`notes-body layout-${layout}`}>
                {layout !== "preview" && (
                  <textarea
                    ref={editorRef}
                    className="notes-editor"
                    value={content}
                    disabled={loading}
                    placeholder={"# Title\n\nWrite markdown here…"}
                    spellCheck={false}
                    onChange={(e) => setContent(e.target.value)}
                    onKeyDown={onEditorKeyDown}
                    onScroll={(e) => syncScroll(e.currentTarget, previewRef.current)}
                  />
                )}
                {layout !== "edit" && (
                  <div
                    ref={previewRef}
                    className="notes-preview markdown-body"
                    onClick={onPreviewClick}
                    onScroll={(e) => syncScroll(e.currentTarget, editorRef.current)}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                )}
              </div>
            )}

            <div className="notes-footer">
              <span className={`notes-save-state ${saveState}`}>{locked ? "Locked" : statusLabel}</span>
              {!locked && (
                <span>
                  {stats.words} words · {stats.lines} lines
                </span>
              )}
            </div>
          </>
        )}
      </section>

      {passDialog && (
        <PassphraseDialog
          title={passDialog.kind === "encrypt" ? "Encrypt note" : "Change passphrase"}
          submitLabel={passDialog.kind === "encrypt" ? "Encrypt" : "Change"}
          onCancel={() => setPassDialog(null)}
          onSubmit={async (pass) => {
            setPassDialog(null);
            await setEncryption(pass);
          }}
        />
      )}
    </div>
  );
}

function PassphraseDialog({
  title,
  submitLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (pass: string) => void | Promise<void>;
}) {
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const tooShort = pass.length > 0 && pass.length < MIN_PASSPHRASE;
  const mismatch = again.length > 0 && pass !== again;
  const valid = pass.length >= MIN_PASSPHRASE && pass === again;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal notes-pass-modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void onSubmit(pass);
        }}
      >
        <h3>{title}</h3>
        <p className="notes-pass-hint">
          Argon2id + AES-256-GCM. The passphrase is never stored: if you lose it, the note cannot be recovered.
        </p>
        <input
          className="kube-input"
          type="password"
          placeholder={`Passphrase (min ${MIN_PASSPHRASE} characters)`}
          value={pass}
          autoFocus
          onChange={(e) => setPass(e.target.value)}
        />
        <input
          className="kube-input"
          type="password"
          placeholder="Repeat passphrase"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
        {(tooShort || mismatch) && (
          <div className="notes-unlock-error">
            {tooShort ? `Use at least ${MIN_PASSPHRASE} characters` : "Passphrases do not match"}
          </div>
        )}
        <div className="notes-pass-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
