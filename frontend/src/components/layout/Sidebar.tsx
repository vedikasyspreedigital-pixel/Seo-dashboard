import { NavLink } from 'react-router-dom';
import type { ComponentType, SVGProps } from 'react';
import { BarChartIcon, DocumentIcon, GridIcon, LayoutIcon, SettingsIcon } from '../ui/icons';

function SidebarIcon({
  to,
  icon: Icon,
  label,
  disabled = false,
}: {
  to?: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  disabled?: boolean;
}) {
  const base =
    'flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-all duration-200 ease-out';

  if (disabled || !to) {
    return (
      <button
        type="button"
        disabled
        title={label}
        className={`${base} cursor-not-allowed border-white/[0.06] bg-white/[0.02] text-[var(--color-ink-faint)] opacity-50`}
      >
        <Icon className="h-4.5 w-4.5" />
      </button>
    );
  }

  return (
    <NavLink
      to={to}
      title={label}
      className={({ isActive }) =>
        `${base} ${
          isActive
            ? 'border-transparent bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-[0_0_15px_rgba(139,92,246,0.3),0_0_35px_rgba(139,92,246,0.12)]'
            : 'border-white/[0.06] bg-white/[0.02] text-[var(--color-ink-muted)] hover:border-white/[0.1] hover:bg-white/[0.05] hover:text-[var(--color-ink)]'
        }`
      }
    >
      <Icon className="h-4.5 w-4.5" />
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <aside className="flex h-screen w-[84px] shrink-0 flex-col items-center gap-1.5 border-r border-[var(--color-border)] py-6">
      <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-[0_0_15px_rgba(139,92,246,0.3),0_0_35px_rgba(139,92,246,0.12)]">
        <BarChartIcon className="h-5 w-5" />
      </div>

      <nav className="flex flex-col items-center gap-2">
        <SidebarIcon to="/overview" icon={LayoutIcon} label="Overview" />
        <SidebarIcon to="/runs" icon={GridIcon} label="Runs" />
        <SidebarIcon to="/reports" icon={DocumentIcon} label="Reports" />
      </nav>

      <div className="mt-auto flex flex-col items-center gap-2">
        <SidebarIcon icon={SettingsIcon} label="Client Settings (not built yet)" disabled />
      </div>
    </aside>
  );
}
