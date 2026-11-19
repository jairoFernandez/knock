// Icon set for the terminal dock and panes. One 16px grid, one stroke width,
// so every control in the terminal chrome reads as the same family.

export type TermIconName =
  | "plus"
  | "splitRight"
  | "splitDown"
  | "close"
  | "chevronDown"
  | "chevronUp"
  | "maximize"
  | "restore"
  | "reset"
  | "search"
  | "arrowUp"
  | "arrowDown"
  | "star"
  | "more";

const PATHS: Record<TermIconName, React.ReactNode> = {
  plus: (
    <>
      <path d="M8 3.5v9" />
      <path d="M3.5 8h9" />
    </>
  ),
  splitRight: (
    <>
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
      <path d="M8 2.75v10.5" />
      <rect x="8" y="2.75" width="6" height="10.5" rx="0" fill="currentColor" stroke="none" opacity="0.22" />
    </>
  ),
  splitDown: (
    <>
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" />
      <path d="M2 8h12" />
      <rect x="2" y="8" width="12" height="5.25" rx="0" fill="currentColor" stroke="none" opacity="0.22" />
    </>
  ),
  close: (
    <>
      <path d="M4.75 4.75l6.5 6.5" />
      <path d="M11.25 4.75l-6.5 6.5" />
    </>
  ),
  chevronDown: <path d="M4.5 6.25 8 9.75l3.5-3.5" />,
  chevronUp: <path d="M4.5 9.75 8 6.25l3.5 3.5" />,
  maximize: (
    <>
      <path d="M9.5 2.75h3.75V6.5" />
      <path d="M6.5 13.25H2.75V9.5" />
      <path d="M13.25 2.75 9.25 6.75" />
      <path d="M2.75 13.25l4-4" />
    </>
  ),
  restore: (
    <>
      <path d="M13.25 6.5H9.5V2.75" />
      <path d="M2.75 9.5H6.5v3.75" />
      <path d="M9.5 6.5l3.75-3.75" />
      <path d="M6.5 9.5l-3.75 3.75" />
    </>
  ),
  reset: (
    <>
      <path d="M3 8a5 5 0 1 0 1.6-3.65" />
      <path d="M3 2.75v3h3" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.25" />
      <path d="m10.25 10.25 3 3" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M8 12.75v-9.5" />
      <path d="M4.25 7 8 3.25 11.75 7" />
    </>
  ),
  arrowDown: (
    <>
      <path d="M8 3.25v9.5" />
      <path d="M4.25 9 8 12.75 11.75 9" />
    </>
  ),
  star: <path d="M8 2.5 9.6 6l3.9.4-2.9 2.6.8 3.8L8 11l-3.4 1.8.8-3.8L2.5 6.4 6.4 6z" />,
  more: (
    <>
      <circle cx="3.75" cy="8" r="0.6" fill="currentColor" />
      <circle cx="8" cy="8" r="0.6" fill="currentColor" />
      <circle cx="12.25" cy="8" r="0.6" fill="currentColor" />
    </>
  ),
};

export function TermIcon({ name, size = 14 }: { name: TermIconName; size?: number }) {
  return (
    <svg
      className="term-icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}
