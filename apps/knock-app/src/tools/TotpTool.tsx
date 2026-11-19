import { useEffect, useMemo, useState } from "react";
import { parseTotpInput, secondsRemaining, totp, type TotpConfig } from "../security/totp";
import { CopyButton } from "./shared";
import { LocalOnlyNote } from "./securityUi";

export function TotpTool() {
  // Not persisted: a TOTP seed is a long-lived credential.
  const [input, setInput] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [codes, setCodes] = useState<{ prev: string; current: string; next: string } | null>(null);

  const parsed = useMemo((): { cfg: TotpConfig } | { error: string } | null => {
    if (!input.trim()) return null;
    try {
      return { cfg: parseTotpInput(input) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [input]);
  const cfg = parsed && "cfg" in parsed ? parsed.cfg : null;

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const step = cfg ? Math.floor(now / 1000 / cfg.period) : 0;
  useEffect(() => {
    if (!cfg) {
      setCodes(null);
      return;
    }
    let active = true;
    const t = Date.now();
    void Promise.all([totp(cfg, t, -1), totp(cfg, t), totp(cfg, t, 1)]).then(([prev, current, next]) => {
      if (active) setCodes({ prev, current, next });
    });
    return () => {
      active = false;
    };
  }, [cfg, step]);

  const remaining = cfg ? secondsRemaining(now, cfg.period) : 0;
  const pct = cfg ? (remaining / cfg.period) * 100 : 0;
  const group = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c);

  return (
    <>
      <label className="tools-label">Secret or otpauth:// URI</label>
      <input
        type="password"
        className="tools-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="JBSWY3DPEHPK3PXP  or  otpauth://totp/Issuer:user?secret=…"
        spellCheck={false}
        autoComplete="off"
      />
      {parsed && "error" in parsed && <div className="tools-error">{parsed.error}</div>}
      {cfg && codes && (
        <>
          {(cfg.issuer || cfg.account) && (
            <div className="tools-hint">
              {cfg.issuer}
              {cfg.issuer && cfg.account ? " · " : ""}
              {cfg.account}
            </div>
          )}
          <div className={`sec-totp ${remaining <= 5 ? "expiring" : ""}`}>
            <span className="sec-totp-code">{group(codes.current)}</span>
            <CopyButton text={codes.current} />
          </div>
          <div className="sec-totp-bar">
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="sec-totp-meta">
            <span>{remaining}s left</span>
            <span>
              prev <code>{codes.prev}</code> · next <code>{codes.next}</code>
            </span>
          </div>
          <div className="tools-hint">
            {cfg.algorithm} · {cfg.digits} digits · {cfg.period}s period. Servers usually also accept the previous
            code to allow for clock drift.
          </div>
        </>
      )}
      <LocalOnlyNote>The secret stays in memory only; codes are computed on this device.</LocalOnlyNote>
    </>
  );
}
