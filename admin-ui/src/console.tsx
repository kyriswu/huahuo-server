import { Alert, Button } from 'antd';
import { useEffect, useState } from 'react';
import type { AdminIdentity } from './session';
import { UserManagement } from './users';
import {ConfigurationPage} from './configuration';
import { AiTemplatesPage } from './ai-templates';

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
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-console-accent-soft text-console-ink">
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

const pageLabels = { users: '用户管理', configuration: '运行配置', 'ai-templates': 'AI 模板配置' } as const;
type AdminPage = keyof typeof pageLabels;
const currentPage = (): AdminPage => {
  const hash = window.location.hash.slice(1);
  if (hash === 'configuration' || hash === 'ai-templates') return hash;
  return 'users';
};

function WorkspaceNavigation({ collapsed, page }: { collapsed: boolean; page: AdminPage }) {
  const navigationStyle = (active: boolean) => `flex min-h-10 items-center gap-1.5 rounded-[10px] sm:gap-2.5 py-2 text-sm font-semibold whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-console-accent ${active ? 'bg-console-accent-soft text-console-accent' : 'text-console-muted hover:bg-console-canvas hover:text-console-ink'} ${collapsed ? 'justify-center px-2.5' : 'px-2 sm:px-3'}`;
  return (
    <aside id="workspace-sidebar" className="flex items-center justify-between gap-3 overflow-hidden border-b max-sm:flex-col max-sm:items-stretch max-sm:gap-2 border-console-line bg-white px-4 py-3 md:sticky md:top-0 md:h-dvh md:flex-col md:items-stretch md:justify-start md:gap-0 md:border-r md:border-b-0 md:px-3 md:py-0">
      <div className={`md:flex md:h-16 md:items-center ${collapsed ? 'md:justify-center' : 'md:px-2'}`}>
        <Brand compact={collapsed} />
      </div>
      <nav aria-label="管理后台导航" className="flex min-w-0 gap-1 overflow-x-auto max-sm:flex-wrap md:mt-6 md:flex-col md:overflow-visible">
        {!collapsed && <div aria-hidden="true" className="mb-2 hidden px-3 text-xs font-medium text-console-muted md:block">导航</div>}
        <a href="#users" aria-current={page === 'users' ? 'page' : undefined} title="用户管理" className={navigationStyle(page === 'users')}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" className="size-5 shrink-0"><circle cx="9" cy="8" r="3" /><path d="M3.5 20v-2a5.5 5.5 0 0 1 11 0v2M16 5.5a3 3 0 0 1 0 5.8M20.5 20v-2a5.5 5.5 0 0 0-3-4.9" /></svg>
          <span className={collapsed ? 'sr-only' : undefined}>用户管理</span>
        </a>
        <a href="#configuration" aria-current={page==='configuration'?'page':undefined} title="运行配置" className={navigationStyle(page==='configuration')}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" className="size-5 shrink-0"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="12" r="2" fill="currentColor"/><circle cx="8" cy="18" r="2" fill="currentColor"/></svg>
          <span className={collapsed?'sr-only':undefined}>运行配置</span>
        </a>
        <a href="#ai-templates" aria-current={page === 'ai-templates' ? 'page' : undefined} title="AI 模板配置" className={navigationStyle(page === 'ai-templates')}>
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" className="size-5 shrink-0">
            <rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>
          </svg>
          <span className={collapsed ? 'sr-only' : undefined}>AI 模板配置</span>
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

interface AdminConsoleProps {
  csrfToken:string;
  admin: AdminIdentity;
  onLogout: () => void;
  loggingOut: boolean;
  error?: string;
  onSessionExpired: () => void;
}

export function AdminConsole({ admin, csrfToken, onLogout, loggingOut, error, onSessionExpired }: AdminConsoleProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarPreference);
  const [page, setPage] = useState<AdminPage>(currentPage);
  useEffect(() => {
    const changed = () => setPage(currentPage());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
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
      <WorkspaceNavigation collapsed={sidebarCollapsed} page={page} />

      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-console-line bg-white px-3 py-2.5 sm:px-7 lg:px-9">
          <div className="flex items-center gap-2 text-sm sm:gap-3">
            <SidebarToggle collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
            <span aria-hidden="true" className="mr-1 h-5 w-px bg-console-line" />
            <span className="hidden text-console-muted sm:inline">管理后台</span>
            <span aria-hidden="true" className="hidden text-slate-400 sm:inline">/</span>
            <span className="font-medium">{pageLabels[page]}</span>
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

        <main id={page} className="mx-auto grid max-w-7xl grid-cols-1 scroll-mt-16 gap-5 px-4 pt-5 pb-10 sm:px-8 sm:pt-8 lg:px-10">
          {error && <Alert type="error" showIcon title={error} />}
          {page === 'users' && <UserManagement onSessionExpired={onSessionExpired} />}
          {page === 'configuration' && <ConfigurationPage admin={admin} csrfToken={csrfToken} onSessionExpired={onSessionExpired} />}
          {page === 'ai-templates' && <AiTemplatesPage csrfToken={csrfToken} onSessionExpired={onSessionExpired} />}
        </main>
      </div>
    </div>
  );
}
