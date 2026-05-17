import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface Props {
  name: string;
  project: string;
  passphrase?: string | null;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function KubeTerminal({ name, project, passphrase }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const unlistenersRef = useRef<UnlistenFn[]>([]);

  useEffect(() => {
    let cancelled = false;

    const term = new Terminal({
      fontFamily: "Menlo, Monaco, Consolas, 'Courier New', monospace",
      fontSize: 12,
      theme: {
        background: "#0f1115",
        foreground: "#d4d4d8",
      },
      cursorBlink: true,
      convertEol: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (containerRef.current) term.open(containerRef.current);

    termRef.current = term;
    fitRef.current = fit;

    // First render: fit to size, then spawn.
    requestAnimationFrame(async () => {
      try {
        fit.fit();
      } catch {
        /* no-op */
      }
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      try {
        const sessionId = await invoke<string>("terminal_spawn", {
          name,
          project,
          passphrase: passphrase ?? null,
          cols,
          rows,
        });
        if (cancelled) {
          invoke("terminal_kill", { sessionId }).catch(() => undefined);
          return;
        }
        sessionIdRef.current = sessionId;
        const dataEvent = `terminal:data:${sessionId}`;
        const exitEvent = `terminal:exit:${sessionId}`;
        const u1 = await listen<string>(dataEvent, (e) => {
          term.write(decodeBase64(e.payload));
        });
        const u2 = await listen<void>(exitEvent, () => {
          term.write("\r\n[process exited]\r\n");
        });
        unlistenersRef.current.push(u1, u2);
      } catch (e) {
        term.write(`\r\n[failed to spawn shell: ${String(e)}]\r\n`);
      }
    });

    const onData = term.onData((d) => {
      const id = sessionIdRef.current;
      if (!id) return;
      invoke("terminal_write", { sessionId: id, data: d }).catch(() => undefined);
    });

    const onResize = () => {
      try {
        fit.fit();
        const id = sessionIdRef.current;
        if (id) {
          invoke("terminal_resize", {
            sessionId: id,
            cols: term.cols,
            rows: term.rows,
          }).catch(() => undefined);
        }
      } catch {
        /* no-op */
      }
    };
    const ro = new ResizeObserver(onResize);
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      onData.dispose();
      ro.disconnect();
      for (const u of unlistenersRef.current) {
        try {
          u();
        } catch {
          /* no-op */
        }
      }
      const id = sessionIdRef.current;
      if (id) {
        invoke("terminal_kill", { sessionId: id }).catch(() => undefined);
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      sessionIdRef.current = null;
    };
    // intentionally only re-init on name/project/passphrase change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, project, passphrase]);

  return <div ref={containerRef} className="kube-xterm" />;
}
