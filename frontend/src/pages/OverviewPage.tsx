import { useEffect, useState } from "react";
import { AppShell } from "../components/layout/AppShell";
import { PageTitle } from "../components/layout/PageHeader";
import { KpiCard } from "../components/overview/KpiCard";
import { MovementsChart } from "../components/overview/MovementsChart";
import { RecentRunsCard } from "../components/overview/RecentRunsCard";
import { ClientDetailsCard } from "../components/overview/ClientDetailsCard";
import { useActiveClient } from "../context/ClientContext";
import { useSession } from "../context/SessionContext";
import { getOverview } from "../api/client";
import type { OverviewData } from "../api/types";
import {
  MinusCircleIcon,
  PlayCircleIcon,
  TargetIcon,
  TrendDownIcon,
  TrendUpIcon,
} from "../components/ui/icons";

export function OverviewPage() {
  const { activeClient } = useActiveClient();
  const { activeWorkspace } = useSession();
  const [overview, setOverview] = useState<OverviewData | null>(null);

  // Scoped to the active CLIENT (falls back to workspace-wide only if none
  // is selected) -- every tile on this page must reflect whichever client
  // is active, not a mix of scopes. Previously this only depended on
  // activeWorkspace, so switching clients left every KPI/chart/recent-run
  // number showing stale (workspace-wide, or the previous client's) data
  // while only the ClientDetailsCard prop updated -- a real data-
  // correctness bug, not just cosmetic. Re-fetching on activeClient change
  // also means `overview.totalRuns` is already this client's real run
  // count, so a separate getRuns() call for the ClientDetailsCard's "Total
  // Runs" figure is no longer needed.
  useEffect(() => {
    if (!activeWorkspace) return;
    let cancelled = false;
    setOverview(null); // clear stale data immediately -- never show the previous client's numbers while the new ones load
    getOverview(activeWorkspace.id, activeClient?.id).then((data) => {
      if (!cancelled) setOverview(data);
    });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspace, activeClient]);

  return (
    <AppShell wide>
      <PageTitle title="Overall Overview" subtitle="Welcome back, Admin 👋" className="mb-6" />

      {!overview ? (
        <div className="py-24 text-center text-sm text-[var(--color-ink-faint)]">
          Loading overview...
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {/* Client details + a 2x2 grid of the 4 activity KPIs on the other half */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <ClientDetailsCard
              client={activeClient}
              totalRunsForClient={activeClient ? overview.totalRuns : null}
            />
            <div className="grid grid-cols-2 grid-rows-2 gap-3.5">
              <KpiCard
                icon={PlayCircleIcon}
                label="Total Runs"
                value={overview.totalRuns}
              />
              <KpiCard
                icon={TrendUpIcon}
                label="Ranking Increased"
                value={overview.rankingMovements.improved}
                iconTone="violet"
              />
              <KpiCard
                icon={TrendDownIcon}
                label="Ranking Decreased"
                value={overview.rankingMovements.declined}
              />
              <KpiCard
                icon={MinusCircleIcon}
                label="No Change"
                value={overview.rankingMovements.unchanged}
              />
            </div>
          </div>

          {/* Chart + recent runs. The page scrolls normally -- only Recent
              Runs' own list scrolls internally, via a fixed card height
              (see RecentRunsCard), not by constraining the whole page. */}
          <div className="grid grid-cols-1 gap-5 lg:h-[420px] lg:grid-cols-[1.7fr_1fr] scrollbar-hidden">
            <MovementsChart data={overview.dailyMovements} />
            <RecentRunsCard runs={overview.recentRuns} />
          </div>

          {/* Supporting SEO KPIs -- real ranking-tracking metrics only */}
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-5">
            <KpiCard
              icon={TargetIcon}
              label="Keywords Tracked"
              value={overview.totalKeywordsTracked}
            />
            <KpiCard
              icon={TrendUpIcon}
              label="Top 3 Rankings"
              value={overview.top3Count}
            />
            <KpiCard
              icon={TargetIcon}
              label="Top 10 Rankings"
              value={overview.top10Count}
            />
            <KpiCard
              icon={TrendDownIcon}
              label="Not in Top 100"
              value={overview.notIn100Count}
            />
            <KpiCard
              icon={MinusCircleIcon}
              label="Average Rank"
              value={overview.averageRank ?? "—"}
            />
          </div>
        </div>
      )}
    </AppShell>
  );
}
