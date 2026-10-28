import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Header } from "./Header";
import { TestModeBanner } from "./TestModeBanner";

export function AppShell({
  children,
  wide = false,
  hideClientPicker = false,
}: {
  children: ReactNode;
  wide?: boolean;
  /** For pages that don't use the header's client (Domain Intelligence types its own). */
  hideClientPicker?: boolean;
}) {
  return (
    <div className="app-backdrop flex h-screen">
      <Sidebar />
      <div className="ambient-glow flex flex-1 flex-col overflow-hidden">
        <Header hideClientPicker={hideClientPicker} />
        <TestModeBanner />
        <main className="scrollbar-hidden flex-1 overflow-y-auto px-10 py-8">
          <div className={`page-enter ${wide ? "mx-auto max-w-7xl" : "mx-auto max-w-5xl"}`}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
