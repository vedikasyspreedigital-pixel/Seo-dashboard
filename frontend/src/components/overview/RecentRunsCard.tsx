import { Link } from "react-router-dom";
import { Card } from "../ui/Card";
import { StatusBadge } from "../run/StatusBadge";
import {
  CheckCircleIcon,
  ClockIcon,
  LoaderIcon,
  XCircleIcon,
} from "../ui/icons";
import type { OverviewRecentRun } from "../../api/types";

function iconFor(status: string) {
  if (status === "COMPLETED")
    return {
      Icon: CheckCircleIcon,
      tone: "text-emerald-300 bg-emerald-500/10",
    };
  if (status === "COMPLETED_WITH_ERRORS")
    return { Icon: XCircleIcon, tone: "text-amber-300 bg-amber-500/10" };
  if (status === "CANCELLED")
    return {
      Icon: XCircleIcon,
      tone: "text-[var(--color-ink-faint)] bg-white/[0.04]",
    };
  if (status === "PROCESSING")
    return { Icon: LoaderIcon, tone: "text-brand-300 bg-brand-400/10" };
  return {
    Icon: ClockIcon,
    tone: "text-[var(--color-ink-muted)] bg-white/[0.04]",
  };
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function RecentRunsCard({ runs }: { runs: OverviewRecentRun[] }) {
  return (
    <Card className="flex h-full min-h-0 flex-col p-6">
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-brand-400" />
          <p className="text-[13px] font-semibold text-[var(--color-ink)]">
            Recent Runs
          </p>
        </div>
        <Link
          to="/runs"
          className="text-xs font-medium text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
        >
          View All
        </Link>
      </div>

      {/* Only this list scrolls -- the page itself, and every other card on
          it, stays put. */}
      <div className="scrollbar-hidden mt-4 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
        {runs.length === 0 && (
          <p className="py-6 text-center text-sm text-[var(--color-ink-faint)]">
            No runs yet.
          </p>
        )}
        {runs.map((run) => {
          const { Icon, tone } = iconFor(run.status);
          return (
            <Link
              key={run.id}
              to={`/runs/${run.id}`}
              className="flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors hover:bg-white/[0.03]"
            >
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--color-ink)]">
                  {run.clientName}
                </span>
                <span className="block truncate text-xs text-[var(--color-ink-faint)]">
                  {run.sourceFilename}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <StatusBadge status={run.status} />
                <span className="mt-1 block text-[11px] text-[var(--color-ink-faint)]">
                  {relativeTime(run.createdAt)}
                </span>
              </span>
            </Link>
          );
        })}
      </div>
    </Card>
  );
}
