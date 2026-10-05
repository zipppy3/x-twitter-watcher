const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

const HTML_UNESCAPE_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Reverse of the few entities the X API puts into tweet text. */
export function unescapeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => HTML_UNESCAPE_MAP[entity] ?? entity);
}
