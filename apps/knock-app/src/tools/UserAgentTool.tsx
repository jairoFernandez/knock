import { useMemo } from "react";
import { CopyInline, HistoryList, useHistory, usePersistedField } from "./shared";

export function UserAgentTool() {
  const [ua, setUa] = usePersistedField<string>("knock.tools.ua.input", "");
  const history = useHistory("knock.tools.ua.history");
  const parsed = useMemo(() => parseUa(ua), [ua]);
  return (
    <>
      <label className="tools-label">User-Agent</label>
      <textarea
        className="tools-textarea"
        value={ua}
        onChange={(e) => setUa(e.target.value)}
        onBlur={() => history.push("ua", ua)}
        spellCheck={false}
        placeholder="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36..."
      />
      {ua && (
        <div className="tools-date-grid">
          <span>Browser</span>
          <span className="tools-mono">
            {parsed.browser}
            <CopyInline text={parsed.browser} />
          </span>
          <span>Engine</span>
          <span className="tools-mono">{parsed.engine}</span>
          <span>OS</span>
          <span className="tools-mono">{parsed.os}</span>
          <span>Device</span>
          <span className="tools-mono">{parsed.device}</span>
          <span>Mobile</span>
          <span className="tools-mono">{parsed.mobile ? "yes" : "no"}</span>
          <span>Bot</span>
          <span className="tools-mono">{parsed.bot ? "yes" : "no"}</span>
        </div>
      )}
      <HistoryList history={history} onPick={setUa} />
    </>
  );
}

function parseUa(ua: string) {
  const lower = ua.toLowerCase();
  const re = (pat: RegExp) => ua.match(pat)?.[0] ?? "";

  let browser = "Unknown";
  if (/Edg\/[\d.]+/i.test(ua)) browser = re(/Edg\/[\d.]+/i).replace("Edg/", "Edge ");
  else if (/OPR\/[\d.]+/i.test(ua)) browser = re(/OPR\/[\d.]+/i).replace("OPR/", "Opera ");
  else if (/Firefox\/[\d.]+/i.test(ua)) browser = re(/Firefox\/[\d.]+/i);
  else if (/Chrome\/[\d.]+/i.test(ua)) browser = re(/Chrome\/[\d.]+/i);
  else if (/Safari\/[\d.]+/i.test(ua) && /Version\/[\d.]+/i.test(ua))
    browser = "Safari " + (re(/Version\/[\d.]+/i).split("/")[1] ?? "");

  let engine = "Unknown";
  if (lower.includes("webkit")) engine = "WebKit";
  if (lower.includes("gecko") && !lower.includes("like gecko")) engine = "Gecko";
  if (lower.includes("blink")) engine = "Blink";
  if (lower.includes("trident")) engine = "Trident";

  let os = "Unknown";
  if (/Windows NT 10/i.test(ua)) os = "Windows 10/11";
  else if (/Windows NT 6\.3/i.test(ua)) os = "Windows 8.1";
  else if (/Windows NT 6\.2/i.test(ua)) os = "Windows 8";
  else if (/Windows NT 6\.1/i.test(ua)) os = "Windows 7";
  else if (/Mac OS X ([\d_.]+)/i.test(ua)) {
    const m = ua.match(/Mac OS X ([\d_.]+)/i);
    os = "macOS " + (m ? m[1].replace(/_/g, ".") : "");
  } else if (/Android ([\d.]+)/i.test(ua)) os = "Android " + (ua.match(/Android ([\d.]+)/i)?.[1] ?? "");
  else if (/iPhone OS ([\d_]+)/i.test(ua))
    os = "iOS " + (ua.match(/iPhone OS ([\d_]+)/i)?.[1].replace(/_/g, ".") ?? "");
  else if (/Linux/i.test(ua)) os = "Linux";

  let device = "Desktop";
  if (/iPhone/i.test(ua)) device = "iPhone";
  else if (/iPad/i.test(ua)) device = "iPad";
  else if (/Android/i.test(ua) && /Mobile/i.test(ua)) device = "Android phone";
  else if (/Android/i.test(ua)) device = "Android tablet";

  const mobile = /Mobile|Android|iPhone|iPad/i.test(ua);
  const bot = /bot|crawler|spider|slurp|googlebot|bingbot|baiduspider/i.test(ua);

  return { browser, engine, os, device, mobile, bot };
}
