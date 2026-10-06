/** Removes URLs and host names from a log line, so diagnostics are safe to paste into a public issue. */
export function scrub(line: string): string {
  return line.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>').replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '<host>');
}
