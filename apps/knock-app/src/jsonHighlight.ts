function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function highlightJson(json: string): string {
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "json-num";
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "json-key" : "json-str";
      } else if (/true|false/.test(match)) {
        cls = "json-bool";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    },
  );
}
