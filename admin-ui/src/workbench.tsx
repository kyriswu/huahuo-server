import { Alert, Button } from 'antd';
import { useState, type ReactNode } from 'react';
import type { AdminIdentity } from './session';

type SampleRecord = {
  id: string;
  name: string;
  status: 'pending' | 'complete';
  updatedAt: string;
};

const records: SampleRecord[] = [
  { id: 'DEMO-001', name: '示例记录 01', status: 'complete', updatedAt: '2026-11-06 10:42' },
  { id: 'DEMO-002', name: '示例记录 02', status: 'pending', updatedAt: '2026-11-06 10:24' },
  { id: 'DEMO-003', name: '示例记录 03', status: 'complete', updatedAt: '2026-11-06 09:56' },
  { id: 'DEMO-004', name: '示例记录 04', status: 'pending', updatedAt: '2026-11-06 09:18' },
];

const pendingCount = records.filter(record => record.status === 'pending').length;
const stats = [
  { label: '记录总数', value: records.length, dot: 'bg-console-accent' },
  { label: '待处理', value: pendingCount, dot: 'bg-amber-600' },
  { label: '已完成', value: records.length - pendingCount, dot: 'bg-emerald-600' },
];

const sidebarPreferenceKey = 'huahuo.admin.sidebar.collapsed';

function readSidebarPreference() {
  try {
    return localStorage.getItem(sidebarPreferenceKey) === 'true';
  } catch {
    return false;
  }
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-[#fff0eb] text-[#be4c3b]">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" className="size-[21px]">
          <path d="M12 1.5 14.9 9.1 22.5 12l-7.6 2.9-2.9 7.6-2.9-7.6L1.5 12l7.6-2.9L12 1.5Z" />
        </svg>
      </span>
      <div className={compact ? 'sr-only' : 'whitespace-nowrap'}>
        <div className="text-base leading-5 font-semibold tracking-tight">花火</div>
        <div className="mt-0.5 text-xs text-console-muted">管理后台</div>
      </div>
    </div>
  );
}

function WorkspaceNavigation({ collapsed }: { collapsed: boolean }) {
  return (
    <aside id="workspace-sidebar" className="flex items-center justify-between gap-3 overflow-hidden border-b border-console-line bg-white px-4 py-3 md:sticky md:top-0 md:h-dvh md:flex-col md:items-stretch md:justify-start md:gap-0 md:border-r md:border-b-0 md:px-3 md:py-0">
      <div className={`md:flex md:h-16 md:items-center ${collapsed ? 'md:justify-center' : 'md:px-2'}`}>
        <Brand compact={collapsed} />
      </div>
      <nav aria-label="管理后台导航" className="md:mt-6">
        {!collapsed && <div aria-hidden="true" className="mb-2 hidden px-3 text-xs font-medium text-console-muted md:block">导航</div>}
        <a href="#workbench" aria-current="page" title="工作台" className={`flex min-h-10 items-center gap-2.5 rounded-[10px] bg-console-accent-soft py-2 text-sm font-semibold whitespace-nowrap text-console-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-console-accent ${collapsed ? 'justify-center px-2.5' : 'px-3'}`}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" className="size-5 shrink-0">
            <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.25" />
            <rect x="14" y="3.5" width="6.5" height="6.5" rx="1.25" />
            <rect x="3.5" y="14" width="6.5" height="6.5" rx="1.25" />
            <rect x="14" y="14" width="6.5" height="6.5" rx="1.25" />
          </svg>
          <span className={collapsed ? 'sr-only' : undefined}>工作台</span>
        </a>
      </nav>
    </aside>
  );
}

function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? '展开侧栏' : '收起侧栏';
  return (
    <Button type="text" aria-controls="workspace-sidebar" aria-expanded={!collapsed} aria-label={label} title={label} onClick={onToggle} icon={(
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="size-5 text-console-muted">
        <rect x="3" y="4.5" width="18" height="15" rx="2" />
        <path d="M9 4.5v15" />
        <path d={collapsed ? 'm13.5 9 3 3-3 3' : 'm16.5 9-3 3 3 3'} />
      </svg>
    )} />
  );
}

function Panel({ title, titleId, meta, children }: { title: string; titleId: string; meta?: string; children: ReactNode }) {
  return (
    <details open className="console-panel group/panel overflow-hidden rounded-2xl border border-console-line bg-white shadow-console-panel">
      <summary className="flex min-h-15 cursor-pointer list-none items-center justify-between gap-3 border-b border-transparent px-4 py-3 select-none hover:bg-console-canvas/80 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-console-accent group-open/panel:border-console-line sm:px-6">
        <h2 className="flex min-w-0 items-center gap-2.5 text-sm font-semibold sm:text-base">
          <span id={titleId}>{title}</span>
          {meta && <span className="rounded-full bg-console-canvas px-2.5 py-0.5 text-xs font-medium text-console-muted">{meta}</span>}
        </h2>
        <span aria-hidden="true" className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-console-muted">
          <span className="group-open/panel:hidden">展开</span>
          <span className="hidden group-open/panel:inline">收起</span>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="size-4 motion-safe:transition-transform group-open/panel:rotate-180">
            <path d="m5 8 5 5 5-5" />
          </svg>
        </span>
      </summary>
      {children}
    </details>
  );
}

function WorkbenchHero() {
  return (
    <section aria-labelledby="workbench-title" className="workbench-hero relative isolate overflow-hidden rounded-2xl border border-console-line px-5 py-6 shadow-console-panel sm:px-8 sm:py-8">
      <svg aria-hidden="true" viewBox="0 0 335 188" fill="none" className="pointer-events-none absolute right-0 bottom-0 -z-10 h-full w-56 translate-x-12 opacity-60 sm:w-80 sm:translate-x-0 sm:opacity-100" preserveAspectRatio="xMaxYMid slice">
        <g stroke="#d9d0f4">
          <circle cx="225" cy="94" r="36" />
          <circle cx="225" cy="94" r="58" />
          <circle cx="225" cy="94" r="80" />
          <circle cx="225" cy="94" r="104" />
        </g>
        <path d="M225 66 232 87 253 94 232 101 225 122 218 101 197 94 218 87Z" fill="#c3b5ef" />
        <circle cx="225" cy="36" r="3.5" fill="#b9a8e8" />
        <circle cx="294" cy="135" r="4.5" fill="#d5a7c7" />
        <circle cx="139" cy="36" r="3" fill="#dfc1e2" />
      </svg>
      <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e4ddf8] bg-white/75 px-2.5 py-1 text-xs font-medium text-console-accent">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-console-accent" />
        示例数据
      </span>
      <h1 id="workbench-title" className="mt-3 text-[1.85rem] leading-tight font-semibold tracking-tight sm:text-4xl">工作台</h1>
      <p className="mt-2 text-sm leading-6 text-console-muted">查看示例记录和处理概况。</p>
    </section>
  );
}

interface WorkbenchProps {
  admin?: AdminIdentity;
  onLogout?: () => void;
  loggingOut?: boolean;
  error?: string;
}

export function Workbench({ admin, onLogout, loggingOut, error }: WorkbenchProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarPreference);
  const sidebarColumns = sidebarCollapsed ? 'md:grid-cols-[4.75rem_minmax(0,1fr)]' : 'md:grid-cols-[14rem_minmax(0,1fr)]';

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(sidebarPreferenceKey, String(next));
    } catch {
      // The control remains usable when browser storage is unavailable.
    }
  }

  return (
    <div className={`min-h-dvh md:grid motion-safe:transition-[grid-template-columns] motion-safe:duration-200 ${sidebarColumns}`}>
      <WorkspaceNavigation collapsed={sidebarCollapsed} />

      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-console-line bg-white/95 px-3 py-2.5 backdrop-blur-sm sm:px-7 lg:px-9">
          <div className="flex items-center gap-2 text-sm sm:gap-3">
            <SidebarToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
            <span aria-hidden="true" className="mr-1 h-5 w-px bg-console-line" />
            <span className="hidden text-console-muted sm:inline">管理后台</span>
            <span aria-hidden="true" className="hidden text-slate-400 sm:inline">/</span>
            <span className="font-medium">工作台</span>
          </div>
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            {admin && (
              <div className="hidden min-w-0 items-center gap-2.5 sm:flex">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-full bg-console-accent-soft text-xs font-semibold text-console-accent">管</span>
                <div className="min-w-0">
                  <div className="max-w-32 truncate text-sm font-medium" title={admin.username}>{admin.username}</div>
                  <div className="text-xs text-console-muted">{admin.role === 'superadmin' ? '超级管理员' : '运营管理员'}</div>
                </div>
              </div>
            )}
            {onLogout && <Button size="small" loading={loggingOut} onClick={onLogout}>退出登录</Button>}
          </div>
        </header>

        <main id="workbench" className="mx-auto grid max-w-7xl scroll-mt-16 gap-5 px-4 pt-5 pb-10 sm:px-8 sm:pt-8 lg:px-10">
          <WorkbenchHero />
          {error && <Alert type="error" showIcon title={error} />}

          <Panel title="概况" titleId="overview-title">
            <dl aria-labelledby="overview-title" className="grid grid-cols-3 gap-2 p-3 sm:gap-4 sm:p-5">
              {stats.map(stat => (
                <div key={stat.label} className="rounded-xl border border-console-line bg-console-canvas/70 px-2.5 py-3 sm:px-5 sm:py-4">
                  <dt className="flex items-center gap-1.5 text-xs font-medium text-console-muted sm:gap-2 sm:text-sm">
                    <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${stat.dot}`} />
                    {stat.label}
                  </dt>
                  <dd className="mt-2 text-2xl leading-tight font-semibold tracking-tight tabular-nums sm:text-3xl">{stat.value}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel title="示例记录" titleId="sample-title" meta={`共 ${records.length} 条`}>
            <table className="w-full text-left text-sm" aria-labelledby="sample-title">
              <thead className="border-b border-console-line bg-console-canvas/80 text-xs text-console-muted">
                <tr>
                  <th scope="col" className="w-1/2 px-4 py-3 font-medium sm:px-6">记录</th>
                  <th scope="col" className="px-4 py-3 font-medium sm:px-6">状态</th>
                  <th scope="col" className="hidden px-6 py-3 font-medium sm:table-cell">更新时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {records.map(record => (
                  <tr key={record.id}>
                    <th scope="row" className="px-4 py-3 font-medium sm:px-6">
                      {record.name}
                      <span className="mt-0.5 block font-mono text-xs font-normal text-console-muted">{record.id}</span>
                    </th>
                    <td className="px-4 py-3 sm:px-6">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs leading-none font-medium whitespace-nowrap ${record.status === 'complete' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
                        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                        {record.status === 'complete' ? '已完成' : '待处理'}
                      </span>
                    </td>
                    <td className="hidden px-6 py-3 text-console-muted tabular-nums sm:table-cell">{record.updatedAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </main>
      </div>
    </div>
  );
}
