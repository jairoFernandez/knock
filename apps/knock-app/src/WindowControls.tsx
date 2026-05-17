import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const plat = (navigator as { platform?: string }).platform || "";
  return /Mac|iPhone|iPad|iPod/i.test(ua) || /Mac/i.test(plat);
}

let decorationsApplied = false;

export function WindowControls() {
  const [isMac] = useState(detectIsMac);

  useEffect(() => {
    if (!isMac || decorationsApplied) return;
    decorationsApplied = true;
    getCurrentWindow()
      .setDecorations(true)
      .catch(() => undefined);
  }, [isMac]);

  if (isMac) {
    // macOS shows native traffic lights via native decorations; nothing to render.
    return null;
  }

  const win = getCurrentWindow();
  return (
    <div className="win-controls">
      <button className="win-btn" onClick={() => win.minimize()} title="Minimize">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button className="win-btn" onClick={() => win.toggleMaximize()} title="Maximize">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button className="win-btn close" onClick={() => win.close()} title="Close">
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </div>
  );
}
