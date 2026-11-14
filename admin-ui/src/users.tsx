import { Alert, Button, Empty, Input, Pagination, Select, Skeleton } from 'antd';
import { useEffect, useState, type FormEvent } from 'react';
import { AdminApiError, adminRequest } from './session';

type UserStatus = 'active' | 'suspended' | 'deleted';
interface User {
  userId: string;
  displayName: string;
  phoneMasked: string | null;
  status: UserStatus;
  createdAt: string;
}
interface UserList { items: User[]; total: number; page: number; pageSize: number }
interface Filters { search: string; status: UserStatus | ''; page: number; pageSize: number }

const initialFilters: Filters = { search: '', status: '', page: 1, pageSize: 20 };
const statuses = {
  active: { label: '正常', style: 'bg-emerald-50 text-emerald-800' },
  suspended: { label: '已停用', style: 'bg-amber-50 text-amber-800' },
  deleted: { label: '已注销', style: 'bg-slate-100 text-slate-600' },
};
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function Status({ status }: { status: UserStatus }) {
  const value = statuses[status];
  return <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap ${value.style}`}>
    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{value.label}
  </span>;
}

export function UserManagement({ onSessionExpired }: { onSessionExpired?: () => void }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Filters['status']>('');
  const [filters, setFilters] = useState(initialFilters);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<UserList>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [copyFeedback, setCopyFeedback] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
    if (filters.search) query.set('search', filters.search);
    if (filters.status) query.set('status', filters.status);
    setLoading(true);
    setData(undefined);
    setError(undefined);
    adminRequest<UserList>(`users?${query}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result.items.length === 0 && result.total > 0 && filters.page > 1) {
        setFilters(current => ({ ...current, page: Math.ceil(result.total / current.pageSize) }));
        return;
      }
      setData(result);
      setLoading(false);
    }, cause => {
      if (controller.signal.aborted) return;
      setLoading(false);
      if (cause instanceof AdminApiError && cause.status === 401) {
        setError('登录已过期，请重新登录。');
        onSessionExpired?.();
      } else if (cause instanceof AdminApiError && cause.status === 403) {
        setError('当前管理员账号没有查看用户的权限。');
      } else {
        setError('用户列表加载失败，请重试。');
      }
    });
    return () => controller.abort();
  }, [filters, attempt, onSessionExpired]);

  function query(event: FormEvent) {
    event.preventDefault();
    setFilters(current => ({ ...current, search: search.trim(), status, page: 1 }));
  }

  function reset() {
    setSearch('');
    setStatus('');
    setFilters(initialFilters);
    setAttempt(current => current + 1);
  }

  async function copyId(userId: string) {
    try {
      await navigator.clipboard.writeText(userId);
      setCopyFeedback(`已复制用户 ID：${userId}`);
    } catch {
      setCopyFeedback('复制失败，请选中用户 ID 后手动复制。');
    }
  }

  function userIdentity(user: User) {
    return <div className="min-w-0">
      <div className="max-w-md font-medium break-words">{user.displayName}</div>
      <div className="mt-1 flex items-center gap-1.5 text-xs text-console-muted">
        <span className="font-mono break-all select-all">{user.userId}</span>
        <button type="button" aria-label={`复制 ${user.displayName} 的用户 ID`} title="复制用户 ID" onClick={() => void copyId(user.userId)} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-console-accent-soft hover:text-console-accent focus-visible:outline-2 focus-visible:outline-console-accent">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" className="size-4"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
        </button>
      </div>
    </div>;
  }

  const filtered = Boolean(filters.search || filters.status);
  return <section aria-labelledby="users-title" className="grid gap-5">
    <div>
      <h1 id="users-title" className="text-2xl leading-tight font-semibold tracking-tight">用户管理</h1>
      <p className="mt-2 text-sm leading-6 text-console-muted">查看用户的基本资料与注册情况。</p>
    </div>

    <div className="overflow-hidden rounded-2xl border border-console-line bg-white">
      <form role="search" aria-label="查询用户" onSubmit={query} className="grid gap-4 border-b border-console-line p-4 sm:flex sm:flex-wrap sm:items-end sm:p-5">
        <div className="grid min-w-0 gap-2 sm:w-80">
          <label htmlFor="user-search" className="text-sm font-medium">昵称或用户 ID</label>
          <Input id="user-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="输入昵称或完整用户 ID" maxLength={120} autoComplete="off" allowClear />
        </div>
        <div className="grid gap-2 sm:w-36">
          <label htmlFor="user-status" className="text-sm font-medium">账号状态</label>
          <Select id="user-status" value={status} onChange={setStatus} options={[
            { value: '', label: '全部状态' },
            ...Object.entries(statuses).map(([value, item]) => ({ value, label: item.label })),
          ]} />
        </div>
        <div className="flex gap-2">
          <Button type="primary" htmlType="submit" loading={loading}>查询</Button>
          <Button htmlType="button" onClick={reset}>重置</Button>
        </div>
      </form>

      <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
        <p aria-live="polite" className="text-sm text-console-muted">{data ? <>共 <span className="font-semibold text-console-ink tabular-nums">{data.total}</span> 位用户{filtered && '符合条件'}</> : loading ? '正在加载用户列表…' : '用户列表'}</p>
        <Button onClick={() => setAttempt(current => current + 1)} disabled={loading}>刷新</Button>
      </div>

      <div aria-busy={loading}>
        {loading && <div role="status" aria-label="正在加载用户列表" className="grid gap-5 border-t border-console-line p-5"><Skeleton active title={false} paragraph={{ rows: 5 }} /></div>}
        {error && <div className="px-4 pb-5 sm:px-5"><Alert type="error" showIcon title={error} action={<Button size="small" onClick={() => setAttempt(current => current + 1)}>重试</Button>} /></div>}
        {data?.items.length === 0 && <div className="border-t border-console-line px-4 py-12"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-console-muted">{filtered ? '没有找到符合条件的用户，请调整查询条件。' : '暂无用户，用户完成首次登录后会显示在这里。'}</span>} />{filtered && <div className="mt-4 text-center"><Button onClick={reset}>清除筛选</Button></div>}</div>}
        {data && data.items.length > 0 && <>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[700px] text-left text-sm" aria-label="用户列表">
              <thead className="border-y border-console-line bg-console-canvas text-xs text-console-muted"><tr>
                <th scope="col" className="px-5 py-3 font-medium">用户 / 用户 ID</th>
                <th scope="col" className="px-5 py-3 font-medium whitespace-nowrap">手机号</th>
                <th scope="col" className="px-5 py-3 font-medium whitespace-nowrap">账号状态</th>
                <th scope="col" className="px-5 py-3 font-medium whitespace-nowrap">注册时间 <span className="font-normal">· 北京时间</span></th>
              </tr></thead>
              <tbody className="divide-y divide-console-line">{data.items.map(user => <tr key={user.userId} className="hover:bg-console-canvas/70">
                <td className="px-5 py-4">{userIdentity(user)}</td>
                <td className="px-5 py-4 whitespace-nowrap tabular-nums">{user.phoneMasked ?? <span className="text-console-muted">未绑定</span>}</td>
                <td className="px-5 py-4"><Status status={user.status} /></td>
                <td className="px-5 py-4 whitespace-nowrap tabular-nums"><time dateTime={user.createdAt}>{dateFormat.format(new Date(user.createdAt))}</time></td>
              </tr>)}</tbody>
            </table>
          </div>
          <ul aria-label="用户列表" className="divide-y divide-console-line border-t border-console-line sm:hidden">{data.items.map(user => <li key={user.userId} className="p-4">
            {userIdentity(user)}
            <dl className="mt-3 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
              <dt className="text-console-muted">手机号</dt><dd className="tabular-nums">{user.phoneMasked ?? '未绑定'}</dd>
              <dt className="text-console-muted">账号状态</dt><dd><Status status={user.status} /></dd>
              <dt className="text-console-muted">注册时间</dt><dd className="tabular-nums"><time dateTime={user.createdAt}>{dateFormat.format(new Date(user.createdAt))}</time><span className="ml-1 text-xs text-console-muted">北京</span></dd>
            </dl>
          </li>)}</ul>
        </>}
      </div>

      {data && data.total > 0 && <div className="flex justify-end border-t border-console-line px-4 py-4 sm:px-5"><Pagination size="small" current={data.page} pageSize={data.pageSize} total={data.total} showSizeChanger={false} disabled={loading} onChange={page => setFilters(current => ({ ...current, page }))} locale={{ prev_page: '上一页', next_page: '下一页', page: '页' }} /></div>}
    </div>
    <p role="status" aria-live="polite" className="min-h-5 text-xs text-console-muted break-all">{copyFeedback}</p>
  </section>;
}
