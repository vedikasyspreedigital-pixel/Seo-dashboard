import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

/**
 * Click-to-sort tables (UI polish, 2026-11-23). `getters` maps a column key to the value it sorts by;
 * null/undefined always sort last, whichever direction.
 */
export function useSort<T, K extends string>(items: T[], getters: Record<K, (item: T) => string | number | null | undefined>, initial: { key: K; dir: SortDir }) {
  const [sort, setSort] = useState(initial);
  const sorted = useMemo(() => {
    const get = getters[sort.key];
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va === null || va === undefined) return vb === null || vb === undefined ? 0 : 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * factor;
      return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * factor;
    });
    // getters are inline objects; sort changes and items are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, sort]);
  const toggle = (key: K, firstDir: SortDir = 'asc') =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir }));
  return { sorted, sort, toggle };
}

export function SortableTh<K extends string>({
  label,
  sortKey,
  sort,
  onSort,
  firstDir = 'asc',
  align = 'left',
  className = '',
}: {
  label: string;
  sortKey: K;
  sort: { key: K; dir: SortDir };
  onSort: (key: K, firstDir?: SortDir) => void;
  firstDir?: SortDir;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={`cell-compact ${align === 'right' ? 'text-right' : ''} ${className}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        onClick={() => onSort(sortKey, firstDir)}
        className={`inline-flex items-center gap-1 whitespace-nowrap uppercase tracking-[inherit] hover:text-[var(--color-ink)] ${active ? 'text-[var(--color-ink)]' : ''}`}
      >
        {label}
        <span aria-hidden className={`text-[10px] ${active ? 'opacity-100' : 'opacity-30'}`}>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '▲▼'}
        </span>
      </button>
    </th>
  );
}
