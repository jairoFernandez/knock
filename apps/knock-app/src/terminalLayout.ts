// Pane-tree helpers for terminal splits. Pure, so they can be unit-tested.

export type Pane =
  | { kind: "leaf"; termId: string }
  | { kind: "split"; orientation: "h" | "v"; ratio: number; a: Pane; b: Pane };

export function collectLeaves(p: Pane): { kind: "leaf"; termId: string }[] {
  if (p.kind === "leaf") return [p];
  return [...collectLeaves(p.a), ...collectLeaves(p.b)];
}

export function replaceLeaf(p: Pane, termId: string, replacement: Pane): Pane {
  if (p.kind === "leaf") {
    return p.termId === termId ? replacement : p;
  }
  return {
    ...p,
    a: replaceLeaf(p.a, termId, replacement),
    b: replaceLeaf(p.b, termId, replacement),
  };
}

export function removeLeaf(p: Pane, termId: string): Pane | null {
  if (p.kind === "leaf") return p.termId === termId ? null : p;
  const a = removeLeaf(p.a, termId);
  const b = removeLeaf(p.b, termId);
  if (a === null && b === null) return null;
  if (a === null) return b!;
  if (b === null) return a!;
  return { ...p, a, b };
}

export function setRatio(p: Pane, path: number[], ratio: number): Pane {
  if (path.length === 0) {
    if (p.kind === "split") return { ...p, ratio };
    return p;
  }
  if (p.kind !== "split") return p;
  const [head, ...rest] = path;
  if (head === 0) return { ...p, a: setRatio(p.a, rest, ratio) };
  if (head === 1) return { ...p, b: setRatio(p.b, rest, ratio) };
  return p;
}

/**
 * Leaf that should take focus once `termId` is closed: the pane that sat
 * next to it in reading order (previous one, else the next), so focus stays
 * where the user was working instead of jumping to the first pane.
 */
export function leafAfterClose(p: Pane, termId: string): string | null {
  const ids = collectLeaves(p).map((l) => l.termId);
  const idx = ids.indexOf(termId);
  if (idx === -1) return ids[0] ?? null;
  const remaining = ids.filter((id) => id !== termId);
  if (remaining.length === 0) return null;
  return remaining[Math.max(0, idx - 1)] ?? remaining[0];
}

/** Height of the collapsed dock: just the tab bar. */
export const DOCK_COLLAPSED_PX = 34;

/**
 * CSS row height for the bottom terminal dock. Collapsed wins over maximized:
 * a maximized dock that gets collapsed must shrink to the tab bar, not keep
 * the full window height with an empty body and the tab bar floating midway.
 */
export function dockRowHeight(state: {
  expanded: boolean;
  maximized: boolean;
  height: number;
}): string {
  if (!state.expanded) return `${DOCK_COLLAPSED_PX}px`;
  if (state.maximized) return "minmax(0, calc(100vh - 58px))";
  return `${state.height}px`;
}
