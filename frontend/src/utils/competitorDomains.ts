// Domain Intelligence competitors typed or pasted by the team (user's request,
// 2026-10-23): a full URL becomes its bare domain, a pasted list fills several
// boxes at once, and anything the report can't use is flagged before fetching.

/** "https://www.Example.com.au/page?x=1" -> "example.com.au"; "" stays "". */
export function toDomain(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/)[0]
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** Splits pasted text (new lines, commas, semicolons, spaces or tabs) into cleaned domains, keeping order. */
export function splitPasted(text: string): string[] {
  return text
    .split(/[\n\r,;\t ]+/)
    .map(toDomain)
    .filter(Boolean);
}

/**
 * Fills the boxes from `index` on with pasted entries (boxes before it are kept); returns null when the
 * paste is a single entry, so the box just takes it as typed.
 */
export function fillFromPaste(boxes: string[], index: number, pasted: string): string[] | null {
  const entries = splitPasted(pasted);
  if (entries.length <= 1) return null;
  const next = [...boxes];
  for (let i = 0; i < entries.length && index + i < next.length; i++) next[index + i] = entries[i];
  return next;
}

/** Per box: why it can't be used (null = fine or empty). */
export function competitorProblems(boxes: string[], clientUrl: string): (string | null)[] {
  const client = toDomain(clientUrl);
  const seen = new Set<string>();
  return boxes.map((box) => {
    const d = toDomain(box);
    if (!d) return null;
    if (!DOMAIN.test(d)) return 'Not a website address';
    if (client && d === client) return 'That’s the client’s own website';
    if (seen.has(d)) return 'Already listed';
    seen.add(d);
    return null;
  });
}
