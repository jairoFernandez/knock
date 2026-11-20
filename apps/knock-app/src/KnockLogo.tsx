/** App mark — same artwork as src-tauri/icons/icon.svg, cropped to the tile. */
export function KnockLogo({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-label="Knock" role="img">
      <defs>
        <linearGradient id="knock-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1d1f2b" />
          <stop offset="1" stopColor="#0e0f16" />
        </linearGradient>
        <linearGradient id="knock-logo-arms" gradientUnits="userSpaceOnUse" x1="420" y1="280" x2="720" y2="740">
          <stop offset="0" stopColor="#b39dff" />
          <stop offset="1" stopColor="#6d4dff" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#knock-logo-bg)" />
      <path d="M360 312V712" fill="none" stroke="#f1eeff" strokeWidth="100" strokeLinecap="round" />
      <path
        d="M676 312L470 512L676 712"
        fill="none"
        stroke="url(#knock-logo-arms)"
        strokeWidth="100"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
