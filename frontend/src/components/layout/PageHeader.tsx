import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export interface Breadcrumb {
  label: string;
  to?: string;
}

export function PageHeader({ breadcrumbs, action }: { breadcrumbs: Breadcrumb[]; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <nav className="flex items-center gap-2 text-sm">
        {breadcrumbs.map((crumb, index) => (
          <span key={index} className="flex items-center gap-2">
            {index > 0 && <span className="text-[var(--color-ink-faint)]">/</span>}
            {crumb.to ? (
              <Link to={crumb.to} className="text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]">
                {crumb.label}
              </Link>
            ) : (
              <span className="font-semibold text-[var(--color-ink)]">{crumb.label}</span>
            )}
          </span>
        ))}
      </nav>
      {action}
    </div>
  );
}

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mt-6">
      <h1 className="text-2xl font-semibold tracking-tight text-[var(--color-ink)]">{title}</h1>
      {subtitle && <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">{subtitle}</p>}
    </div>
  );
}
