import type { ComponentType, ReactNode, SVGProps } from 'react';
import { Card } from '../ui/Card';

interface Props {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  value: string | number;
  caption?: ReactNode;
  iconTone?: 'default' | 'violet';
}

/** Compact icon + label + value KPI card, used across the Overview page's
 * stat rows. No trend arrows/deltas unless the caller passes one via
 * `caption` -- most of these metrics have no real historical baseline to
 * compare against yet, so no percentage change is fabricated. */
export function KpiCard({ icon: Icon, label, value, caption, iconTone = 'default' }: Props) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            iconTone === 'violet'
              ? 'bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-[0_0_15px_rgba(139,92,246,0.25)]'
              : 'border border-white/[0.07] bg-white/[0.03] text-[var(--color-ink-muted)]'
          }`}
        >
          <Icon className="h-4 w-4" />
        </span>
        <p className="text-[13px] font-medium text-[var(--color-ink-muted)]">{label}</p>
      </div>
      <p className="mt-3 font-mono text-[26px] font-bold leading-none tabular-nums text-[var(--color-ink)]">{value}</p>
      {caption && <div className="mt-1.5 text-xs text-[var(--color-ink-faint)]">{caption}</div>}
    </Card>
  );
}
