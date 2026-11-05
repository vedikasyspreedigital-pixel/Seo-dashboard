import type { DraftChange } from './draftChanges';

const MAX_BODY_LINES = 12;

/** The unsaved edits, field by field: old -> new, addresses added/removed, body lines added/removed. */
export function DraftChangesList({ changes }: { changes: DraftChange[] }) {
  return (
    <ul className="flex flex-col gap-3 text-sm">
      {changes.map((c) => (
        <li key={c.field}>
          <p className="font-medium text-[var(--color-ink)]">{c.field}</p>
          {'before' in c && (
            <div className="mt-1 flex flex-col gap-0.5 text-xs">
              <span className="text-rose-300 line-through">{c.before || '(empty)'}</span>
              <span className="text-emerald-300">{c.after || '(empty)'}</span>
            </div>
          )}
          {'added' in c && (
            <div className="mt-1 flex flex-col gap-0.5 text-xs">
              {c.added.map((e) => (
                <span key={`+${e}`} className="text-emerald-300">
                  + {e}
                </span>
              ))}
              {c.removed.map((e) => (
                <span key={`-${e}`} className="text-rose-300">
                  − {e}
                </span>
              ))}
            </div>
          )}
          {'lines' in c && (
            <div className="mt-1 flex flex-col gap-0.5 whitespace-pre-wrap break-words font-mono text-xs">
              {c.lines.slice(0, MAX_BODY_LINES).map((l, i) => (
                <span key={i} className={l.kind === 'added' ? 'text-emerald-300' : 'text-rose-300 line-through'}>
                  {l.kind === 'added' ? '+ ' : '− '}
                  {l.text || '(blank line)'}
                </span>
              ))}
              {c.lines.length > MAX_BODY_LINES && <span className="text-[var(--color-ink-faint)]">…and {c.lines.length - MAX_BODY_LINES} more line changes</span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
