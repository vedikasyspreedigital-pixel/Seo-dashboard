// What the user changed in the email draft but hasn't saved yet -- shown under
// the editor and in the "unsaved changes" check before going to Send.

export interface DraftFields {
  subject: string;
  body: string;
  recipients: string[];
  cc: string[];
  clickupTaskUrl: string;
}

export type DraftChange =
  | { field: 'Subject' | 'ClickUp task'; before: string; after: string }
  | { field: 'Recipients' | 'Cc'; added: string[]; removed: string[] }
  | { field: 'Body'; lines: { kind: 'added' | 'removed'; text: string }[] };

export function describeDraftChanges(saved: DraftFields, current: DraftFields): DraftChange[] {
  const changes: DraftChange[] = [];
  if (saved.subject !== current.subject) changes.push({ field: 'Subject', before: saved.subject, after: current.subject });
  if (saved.body !== current.body) changes.push({ field: 'Body', lines: diffLines(saved.body, current.body) });
  for (const field of ['Recipients', 'Cc'] as const) {
    const before = field === 'Recipients' ? saved.recipients : saved.cc;
    const after = field === 'Recipients' ? current.recipients : current.cc;
    const has = (list: string[], email: string) => list.some((e) => e.toLowerCase() === email.toLowerCase());
    const added = after.filter((e) => !has(before, e));
    const removed = before.filter((e) => !has(after, e));
    if (added.length > 0 || removed.length > 0) changes.push({ field, added, removed });
  }
  if (saved.clickupTaskUrl.trim() !== current.clickupTaskUrl.trim()) {
    changes.push({ field: 'ClickUp task', before: saved.clickupTaskUrl.trim(), after: current.clickupTaskUrl.trim() });
  }
  return changes;
}

/** Lines removed from / added to the body (longest-common-subsequence diff; email bodies are short). */
export function diffLines(before: string, after: string): { kind: 'added' | 'removed'; text: string }[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: { kind: 'added' | 'removed'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      // On a tie the old line goes first, so a replaced line reads old -> new.
      out.push({ kind: 'removed', text: a[i++] });
    } else {
      out.push({ kind: 'added', text: b[j++] });
    }
  }
  return out;
}
