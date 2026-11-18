import { Alert, Button, Drawer, Input, InputNumber, Popconfirm, Select, Skeleton, Switch, Tag, Tooltip } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';

import type { AiTemplateCatalog } from '../../src/modules/ai-templates/catalog.js';
import type { Catalog, SceneKey } from '../../src/modules/ai-templates/model.js';
import { AdminApiError, adminRequest } from './session';

type Item = Catalog['items'][number];
type SceneView = Awaited<ReturnType<AiTemplateCatalog['get']>>;
const scenes = [
  { key: 'note_outline', label: '笔记纲要' },
  { key: 'editor_polish', label: '编辑器润色' },
] as const;
const fallbackMessages: Record<string, string> = {
  AI_TEMPLATE_DRAFT_CONFLICT: '其他人已更新草稿。请先复制需要保留的内容，再重新加载。',
  AI_TEMPLATE_PROMPT_REQUIRED: '请为每个可用模板填写提示词。',
  AI_TEMPLATE_VARIABLE_INVALID: '提示词含有当前场景不支持的变量。',
  AI_TEMPLATE_PARENT_INVALID: '请为子模板选择已有分组。',
  AI_TEMPLATE_TEXT_INVALID: '文案或提示词含有无效字符，请检查复制的内容。',
  BAD_REQUEST: '请检查标题、提示词和展示数量。',
};

const partitionItems = (items: Item[], parentKey: string | null) => items.filter(item =>
  item.kind === 'group' ? parentKey === null : item.parentKey === parentKey);

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1.5"><span className="font-medium">{label}</span>{children}</label>;
}

function CatalogPreview({ catalog }: { catalog: Catalog }) {
  const [parentKey, setParentKey] = useState<string | null>(null);
  const group = catalog.items.find(item => item.kind === 'group' && item.itemKey === parentKey);
  const items = partitionItems(catalog.items, parentKey).filter(item => item.enabled
    && (item.kind === 'template' || partitionItems(catalog.items, item.itemKey).some(child => child.enabled)));
  const limit = group?.kind === 'group' ? group.displayLimit : catalog.displayLimit;
  return (
    <div className="grid gap-4">
      {parentKey && <Button className="justify-self-start" onClick={() => setParentKey(null)}>返回一级目录</Button>}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">{group?.title ?? catalog.title}</h2>
        <span className="text-console-muted">首屏 {Math.min(items.length, limit)} 项 · 共 {items.length} 项</span>
      </div>
      {items.length ? <ul className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
        {items.slice(0, limit).map(item => {
          const content = <>
            <span className="block font-medium wrap-anywhere">{item.icon ? `${item.icon} ` : ''}{item.title}</span>
            {item.description && <span className="mt-1 block text-xs text-console-muted wrap-anywhere">{item.description}</span>}
          </>;
          return <li key={item.itemKey} className="rounded-lg border border-console-line bg-console-canvas">
            {item.kind === 'group'
              ? <button type="button" className="h-full w-full rounded-lg px-3 py-2 text-left hover:bg-console-accent-soft" onClick={() => setParentKey(item.itemKey)}>{content}</button>
              : <div className="px-3 py-2">{content}</div>}
          </li>;
        })}
      </ul> : <p className="text-console-muted">这个目录还没有可展示的模板。</p>}
    </div>
  );
}

export function AiTemplatesPage({ csrfToken, onSessionExpired }: { csrfToken: string; onSessionExpired: () => void }) {
  const [scene, setScene] = useState<SceneKey>('note_outline');
  const [view, setView] = useState<SceneView>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<'preview' | 'history'>();
  const [loadCount, setLoadCount] = useState(0);
  const [pending, setPending] = useState<'draft' | 'publish' | 'restore'>();
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string }>();
  const dirty = !!catalog && catalog !== view?.draft;
  const path = `ai-template-scenes/${scene}`;

  useEffect(() => {
    const controller = new AbortController();
    adminRequest<SceneView>(path, { signal: controller.signal }).then(next => {
      if (controller.signal.aborted) return;
      setView(next);
      setCatalog(next.draft);
      setSelectedKey(null);
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof AdminApiError && error.status === 401) onSessionExpired();
      setNotice({ type: 'error', text: '暂时无法加载模板配置。' });
    });
    return () => controller.abort();
  }, [path, loadCount, onSessionExpired]);

  function load(next: SceneKey) {
    setView(undefined);
    setCatalog(undefined);
    setNotice(undefined);
    if (next === scene) setLoadCount(value => value + 1);
    else setScene(next);
  }

  function changeScene(next: SceneKey) {
    if (next === scene) return;
    if (dirty && !window.confirm('有未保存的修改。切换场景并放弃这些修改？')) return;
    load(next);
  }

  async function save(action: 'draft' | 'publish' | 'restore', version?: number) {
    if (!view || !catalog || pending) return;
    setPending(action);
    setNotice(undefined);
    try {
      const next = await adminRequest<SceneView>(`${path}/${action}`, {
        method: action === 'draft' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          draftRevision: view.draftRevision,
          ...(action === 'restore' ? { version } : { catalog }),
        }),
      });
      setView(next);
      setCatalog(next.draft);
      if (action === 'restore') {
        setSelectedKey(null);
        setPanel(undefined);
      }
      setNotice({ type: 'success', text: action === 'draft' ? '草稿已保存。' : `版本 ${next.publishedRevision} 已发布。` });
    } catch (error) {
      if (error instanceof AdminApiError && error.status === 401) onSessionExpired();
      const message = error instanceof AdminApiError ? fallbackMessages[error.code ?? ''] : undefined;
      setNotice({ type: 'error', text: message ?? '保存失败，请稍后重试。' });
    } finally {
      setPending(undefined);
    }
  }

  const selected = catalog?.items.find(item => item.itemKey === selectedKey);

  function updateItem(item: Item) {
    setCatalog(current => current && ({ ...current, items: current.items.map(previous => previous.itemKey === item.itemKey ? item : previous) }));
  }

  function addItem(kind: Item['kind']) {
    if (!catalog || catalog.items.length >= 50) return;
    const itemKey = 'item_' + Array.from(crypto.getRandomValues(new Uint32Array(2)), value => value.toString(36)).join('_');
    const shared = { itemKey, title: kind === 'group' ? '新分组' : '新模板', description: '', icon: '', enabled: true };
    const parentKey = selected?.kind === 'group' ? selected.itemKey : selected?.parentKey ?? null;
    const item: Item = kind === 'group'
      ? { ...shared, kind, displayLimit: 5 }
      : { ...shared, kind, parentKey, prompt: '' };
    setCatalog({ ...catalog, items: [...catalog.items, item] });
    setSelectedKey(itemKey);
  }

  const siblings = catalog && selected
    ? partitionItems(catalog.items, selected.kind === 'template' ? selected.parentKey : null) : [];
  const selectedIndex = siblings.findIndex(item => item.itemKey === selectedKey);

  function moveItem(step: -1 | 1) {
    const other = siblings[selectedIndex + step];
    if (!catalog || !selected || !other) return;
    const items = catalog.items.map(item =>
      item.itemKey === other.itemKey ? selected : item.itemKey === selected.itemKey ? other : item);
    setCatalog({ ...catalog, items });
  }

  function removeItem() {
    if (!catalog || !selected) return;
    const items = catalog.items.filter(item => item.itemKey !== selected.itemKey).map(item =>
      item.kind === 'template' && item.parentKey === selected.itemKey ? { ...item, parentKey: null } : item);
    setCatalog({ ...catalog, items });
    setSelectedKey(null);
  }

  const row = (item: Item, child = false) => (
    <li key={item.itemKey}>
      <button type="button" disabled={!!pending} aria-pressed={selectedKey === item.itemKey}
        className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-console-canvas disabled:opacity-60 ${child ? 'pl-6' : ''} ${selectedKey === item.itemKey ? 'bg-console-accent-soft font-semibold' : ''}`}
        onClick={() => setSelectedKey(item.itemKey)}>
        <span className="min-w-0 flex-1 wrap-anywhere">{item.title || '未命名'}</span>
        {item.kind === 'group' && <span className="shrink-0 text-xs text-console-muted">分组</span>}
        {!item.enabled && <span className="shrink-0 text-xs text-console-muted">下架</span>}
      </button>
    </li>
  );

  return (
    <section className="grid min-w-0 gap-4" aria-label="AI 模板配置">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2" aria-label="应用场景">
          {scenes.map(option => <Button key={option.key} disabled={!!pending} aria-pressed={scene === option.key}
            type={scene === option.key ? 'primary' : 'default'} onClick={() => changeScene(option.key)}>{option.label}</Button>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view && <Tag className="me-0">已发布 v{view.publishedRevision}</Tag>}
          {dirty && <span role="status" className="text-sm text-console-muted">未保存</span>}
          {!dirty && view?.hasUnpublishedDraft && <span className="text-sm text-console-muted">草稿待发布</span>}
          <Button disabled={!catalog || !!pending} onClick={() => setPanel('preview')}>预览</Button>
          <Button disabled={!view || !!pending} onClick={() => setPanel('history')}>发布记录</Button>
          <div className="flex items-center gap-2">
            <Button disabled={!dirty || !!pending} loading={pending === 'draft'} onClick={() => void save('draft')}>保存草稿</Button>
            <Button type="primary" disabled={!catalog || !!pending || (!dirty && !view?.hasUnpublishedDraft)}
              loading={pending === 'publish'} onClick={() => void save('publish')}>保存并发布</Button>
          </div>
        </div>
      </div>

      {notice && <Alert type={notice.type} title={notice.text} showIcon action={notice.type === 'error'
        ? <Button size="small" onClick={() => { if (!dirty || window.confirm('重新加载并放弃未保存的修改？')) load(scene); }}>重新加载</Button>
        : undefined} />}

      {!catalog && !notice && <Skeleton active paragraph={{ rows: 6 }} />}
      {catalog && <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.9fr)_minmax(0,2fr)]">
        <section className="min-w-0 self-start rounded-xl border border-console-line bg-white p-3 sm:p-4" aria-label="模板目录">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">模板目录</h2>
            <div className="flex gap-1.5">
              <Button size="small" disabled={!!pending || catalog.items.length >= 50} onClick={() => addItem('group')}>新建分组</Button>
              <Button size="small" disabled={!!pending || catalog.items.length >= 50} onClick={() => addItem('template')}>新建模板</Button>
            </div>
          </div>
          <button type="button" disabled={!!pending} aria-pressed={selectedKey === null}
            onClick={() => setSelectedKey(null)} className={`mb-1 w-full rounded-lg px-2.5 py-2 text-left hover:bg-console-canvas ${selectedKey === null ? 'bg-console-accent-soft font-semibold' : ''}`}>场景设置</button>
          <ul className="grid gap-0.5 max-lg:max-h-52 max-lg:overflow-y-auto">
            {partitionItems(catalog.items, null).map(item => item.kind === 'group'
              ? <li key={item.itemKey}><ul>{row(item)}{partitionItems(catalog.items, item.itemKey).map(child => row(child, true))}</ul></li>
              : row(item))}
          </ul>
        </section>

        <section className="min-w-0 rounded-xl border border-console-line bg-white p-4 sm:p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 className="min-w-0 text-base font-semibold wrap-anywhere">{selected ? selected.title || '未命名' : '场景设置'}</h2>
            {selected && <div className="flex flex-wrap gap-2">
              <Button size="small" disabled={!!pending || selectedIndex < 1} onClick={() => moveItem(-1)}>上移</Button>
              <Button size="small" disabled={!!pending || selectedIndex >= siblings.length - 1} onClick={() => moveItem(1)}>下移</Button>
              <Popconfirm title={selected.kind === 'group' ? '移除分组并将子模板移到一级目录？' : '从草稿移除这个模板？'}
                okText="移除" cancelText="取消" onConfirm={removeItem}>
                <Button size="small" danger disabled={!!pending}>移除</Button>
              </Popconfirm>
            </div>}
          </div>
          <fieldset disabled={!!pending} className="grid min-w-0 gap-4">
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
              <Field label="展示标题">
                <Input maxLength={64} value={selected?.title ?? catalog.title}
                  onChange={change => selected ? updateItem({ ...selected, title: change.target.value }) : setCatalog({ ...catalog, title: change.target.value })} />
              </Field>
              {selected?.kind === 'template' ? <Field label="上级分组">
                <Select aria-label="上级分组" value={selected.parentKey ?? ''} disabled={!!pending}
                  options={[{ value: '', label: '一级目录' }, ...catalog.items.flatMap(item => item.kind === 'group' ? [{ value: item.itemKey, label: item.title }] : [])]}
                  onChange={parentKey => updateItem({ ...selected, parentKey: parentKey || null })} />
              </Field> : <Field label="首屏展示数量">
                <InputNumber aria-label="首屏展示数量" className="w-full" min={1} max={50} precision={0}
                  value={selected?.displayLimit ?? catalog.displayLimit} onChange={displayLimit => {
                    if (displayLimit === null) return;
                    if (selected) updateItem({ ...selected, displayLimit });
                    else setCatalog({ ...catalog, displayLimit });
                  }} />
              </Field>}
              {selected && <>
                <Field label="副标题"><Input maxLength={160} value={selected.description}
                  onChange={change => updateItem({ ...selected, description: change.target.value })} /></Field>
                <Field label="图标"><Input maxLength={24} value={selected.icon}
                  onChange={change => updateItem({ ...selected, icon: change.target.value })} /></Field>
              </>}
            </div>
            {selected && <label className="flex items-center gap-2 font-medium">
              <Switch aria-label="上架" checked={selected.enabled} disabled={!!pending} onChange={enabled => updateItem({ ...selected, enabled })} />上架
            </label>}
            {selected?.kind === 'template' && <>
              <div className="flex items-center gap-2">
                <span className="font-medium">接口返回</span>
                <Tooltip title="由 App 每次调用选择。默认一次性返回 JSON，支持 SSE 流式返回。"
                  trigger={['hover', 'focus', 'click']}>
                  <button type="button" aria-label="JSON / SSE 返回方式说明"
                    className="cursor-help rounded border border-console-line bg-console-canvas px-1.5 py-0.5 text-xs text-console-muted">
                    JSON / SSE
                  </button>
                </Tooltip>
              </div>
              <Field label="提示词">
                <Input.TextArea rows={8} maxLength={10_000} showCount value={selected.prompt}
                  onChange={change => updateItem({ ...selected, prompt: change.target.value })} />
              </Field>
              <div className="flex flex-wrap items-center gap-2 text-sm text-console-muted">
                <span>插入变量</span>
                {view?.variables.map(variable => {
                  const placeholder = `{{${variable}}}`;
                  return <Button size="small" key={variable} disabled={!!pending || selected.prompt.length + placeholder.length > 10_000}
                    onClick={() => updateItem({ ...selected, prompt: selected.prompt + placeholder })}>{placeholder}</Button>;
                })}
              </div>
            </>}
          </fieldset>
          {!selected && <p className="mt-4 text-sm text-console-muted">选中目录项可编辑展示文案和提示词。</p>}
        </section>
      </div>}

      <Drawer title={panel === 'preview' ? 'App 目录预览' : '发布记录'} open={!!panel} onClose={() => setPanel(undefined)}>
        {panel === 'preview' && catalog && <CatalogPreview catalog={catalog} />}
        {panel === 'history' && <ul className="divide-y divide-console-line">
          {view?.history.map(version => <li key={version.version} className="flex flex-wrap items-center justify-between gap-2 py-3">
            <div>
              <div className="font-medium">版本 {version.version} {version.version === view.publishedRevision && <Tag>当前发布</Tag>}</div>
              <div className="text-console-muted">{new Date(version.publishedAt).toLocaleString('zh-CN')}{version.restoredFrom && ` · 恢复自版本 ${version.restoredFrom}`}</div>
            </div>
            {version.version !== view.publishedRevision && <Popconfirm title="将此版本重新发布并替换草稿？"
              okText="回滚并发布" cancelText="取消" onConfirm={() => save('restore', version.version)}>
              <Button size="small" disabled={!!pending}>回滚</Button>
            </Popconfirm>}
          </li>)}
        </ul>}
      </Drawer>
    </section>
  );
}
