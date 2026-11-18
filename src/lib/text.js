/**
 * Capitalises the first letter of every word: "wake up at home" -> "Wake Up At Home".
 * Letters after the first in a word are left as they are.
 * Apostrophes are not treated as word starts, so "don't" stays "Don't".
 */
export function toTitleCase(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[\s([{"“])(\p{Ll})/gu, (_, before, letter) => before + letter.toUpperCase());
}

/**
 * Turns notes into one line per bullet point.
 * Bullets can be "•", "-" or "*" at the start of a line, or a "•" inside a line.
 * Output: plain lines stay as they are; each bullet becomes its own line starting with "• ".
 */
export function formatNotes(text) {
  const raw = String(text ?? '').replace(/\r/g, '');
  const out = [];
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/^\s*[-*]\s+/, '• ');
    const segments = line.split('•');
    segments.forEach((segment, idx) => {
      const clean = toTitleCase(segment);
      if (!clean) return;
      const isBullet = idx > 0 || line.trimStart().startsWith('•');
      out.push(isBullet ? `• ${clean}` : clean);
    });
  }
  return out.join('\n');
}
