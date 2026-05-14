const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(VAR_RE, (full, name) => {
    return vars[name] !== undefined ? vars[name] : full;
  });
}

export function hasUnresolvedVars(template: string, vars: Record<string, string>): boolean {
  let m: RegExpExecArray | null;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(template)) !== null) {
    if (vars[m[1]] === undefined) return true;
  }
  return false;
}
