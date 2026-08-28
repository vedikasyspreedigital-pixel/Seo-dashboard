import type { ReactNode } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

export function AppShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="app-backdrop flex h-screen">
      <Sidebar />
      <div className="ambient-glow flex flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto px-10 py-8">
          <div className={wide ? 'mx-auto max-w-7xl' : 'mx-auto max-w-5xl'}>{children}</div>
        </main>
      </div>
    </div>
  );
}
