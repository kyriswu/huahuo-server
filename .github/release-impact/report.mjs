import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cruise } from 'dependency-cruiser';

const roles = ['api-server', 'admin', 'worker', 'scheduler'];
const planPath = 'scripts/release/plan.json';
const sha = /^[a-f0-9]{40}$/;
const source = /^src\/.*\.[cm]?[jt]sx?$/;
const maxBuffer = 32 * 1024 * 1024;
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer });
const code = value => '<code>' + value.replace(/[&<>\r\n]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '\\r', '\n': '\\n',
})[char]) + '</code>';
const list = paths => paths.slice(0, 10).map(code).join('、') + (paths.length > 10 ? ` 等 ${paths.length} 项` : '');

const rules = [
  ['数据库迁移', /^migrations\//, '核对迁移、旧版本兼容及四角色上线范围。'],
  ['数据库读写', /^src\/(?:db\/|.*\/repositor(?:y|ies)\b)/, '核对事务、查询与存量数据兼容。'],
  ['队列与任务', /^src\/(?:entrypoints\/(?:worker|scheduler)\.ts$|modules\/(?:tasks\/|rag\/(?:repository|jobs)\.ts$))/, '按改动核对 API 写入 Outbox、Scheduler 投递和 Worker 对旧任务的消费，包括载荷、幂等与重试。'],
  ['HTTP 契约', /^src\/(?:contracts\/|http\/|.*\/(?:routes|schemas|[-\w]+-routes)\.ts$)/, '核对路由、载荷和鉴权，内部接口变化需核对调用方。'],
  ['配置与运行环境', /^(?:\.env(?:\.|$)|compose\.ya?ml$|Dockerfile$|src\/(?:config\/|modules\/runtime-settings\/))/, '核对配置默认值、角色注入和新旧实例交接。'],
  ['外部依赖', /^(?:pnpm-lock\.yaml$|package\.json$|src\/integrations\/)/, '核对依赖版本或外部协议、权限及共享资源。'],
];

function diff(base, head) {
  const fields = git('diff', '--name-status', '--no-renames', '-z', base, head, '--').split('\0');
  fields.pop();
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push({ status: fields[i], path: fields[i + 1] });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function hasBase(base, head) {
  return sha.test(base ?? '') && base !== '0'.repeat(40)
    && spawnSync('git', ['merge-base', '--is-ancestor', base, head], { stdio: 'ignore' }).status === 0;
}

function loadPlan(head) {
  const plan = JSON.parse(git('show', `${head}:${planPath}`));
  if (!sha.test(plan.baseRevision ?? '') || !Array.isArray(plan.services)
      || !plan.services.every(role => roles.includes(role))) throw Error('invalid release plan');
  return plan;
}

async function graph(root) {
  const { output, exitCode } = await cruise(['src'], {
    baseDir: root,
    doNotFollow: 'node_modules/',
    outputType: 'json',
    tsConfig: { fileName: join(root, 'tsconfig.json') },
    tsPreCompilationDeps: true,
  });
  const { modules } = JSON.parse(output);
  if (exitCode || !modules?.length) throw Error('dependency-cruiser graph unavailable');

  const files = new Set(modules.filter(module => source.test(module.source) && !module.couldNotResolve).map(module => module.source));
  const reverse = new Map();
  const unresolved = new Set();
  for (const { source: importer, dependencies } of modules) {
    if (!files.has(importer)) continue;
    for (const dep of dependencies ?? []) {
      if (dep.couldNotResolve && dep.module.startsWith('.')) unresolved.add(`${importer} → ${dep.module}`);
      if (dep.couldNotResolve || !files.has(dep.resolved)) continue;
      if (!reverse.has(dep.resolved)) reverse.set(dep.resolved, new Set());
      reverse.get(dep.resolved).add(importer);
    }
  }
  return { files, reverse, unresolved };
}

async function archivedGraph(base) {
  const root = mkdtempSync(join(tmpdir(), 'huahuo-release-impact-'));
  try {
    const archive = execFileSync('git', ['archive', base, 'src', 'tsconfig.json', 'package.json'], { maxBuffer });
    execFileSync('tar', ['-xf', '-', '-C', root], { input: archive, maxBuffer });
    return await graph(realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function reach(graph, seeds) {
  const queue = seeds.filter(file => graph.files.has(file));
  const next = new Map(queue.map(file => [file, null]));
  for (const file of queue) {
    for (const importer of graph.reverse.get(file) ?? []) {
      if (next.has(importer)) continue;
      next.set(importer, file);
      queue.push(importer);
    }
  }
  return next;
}

async function describe({ title, base, head, changes, plan }, currentGraph) {
  const changed = changes.map(change => change.path);
  const sources = changed.filter(file => source.test(file));
  const removed = changes.filter(change => change.status === 'D' && source.test(change.path)).map(change => change.path);
  const old = removed.length ? await archivedGraph(base) : undefined;
  const missing = sources.filter(file => !currentGraph.files.has(file) && !old?.files.has(file));
  const current = reach(currentGraph, sources);
  const previous = old ? reach(old, removed) : new Map();
  const moduleNames = paths => [...new Set([...paths].map(path => /^src\/modules\/([^/]+)\//.exec(path)?.[1]).filter(Boolean))].sort();
  const direct = moduleNames(changed);
  const indirect = moduleNames([...current.keys(), ...previous.keys()]).filter(name => !direct.includes(name));

  const output = [
    `### ${title}`,
    '',
    `${code(base)} → ${code(head)}，共 ${changed.length} 个变更文件。`,
    '',
    `- **直接变更业务模块** ${direct.map(code).join('、') || '无'}`,
    `- **导入图发现的下游业务模块** ${indirect.map(code).join('、') || '无'}`,
    `- **后端源码变更** ${sources.length ? list(sources) : '无'}`,
    '',
    '**沿导入图可达的运行角色**',
    '',
  ];
  const reachable = [];
  for (const role of roles) {
    const entrypoint = `src/entrypoints/${role}.ts`;
    const paths = current.has(entrypoint) ? current : previous;
    if (!paths.has(entrypoint)) continue;
    reachable.push(role);
    const path = [];
    for (let file = entrypoint; file; file = paths.get(file)) path.push(code(file));
    output.push(`- ${code(role)}${paths === previous ? '（旧版本依赖）' : ''} · ${path.join(' → ')}`);
  }
  if (!reachable.length) output.push('- 导入图未找到直达角色的路径。');

  const risks = rules.flatMap(([label, pattern, review]) => {
    const matches = changed.filter(file => pattern.test(file));
    return matches.length ? [`- **${label}** ${list(matches)}。 ${review}`] : [];
  });
  if (removed.length) risks.push(`- **源码删除或改名** 沿基准版本回查旧依赖：${list(removed)}。`);
  if (plan) {
    const omitted = reachable.filter(role => !plan.services.includes(role));
    if (omitted.length) risks.push(`- **发布角色复核** 导入图可达但清单未列：${list(omitted)}。结合改动确认发布范围。`);
  }
  const unresolved = [...new Set([...currentGraph.unresolved, ...(old?.unresolved ?? [])])].sort();
  if (missing.length) risks.push(`- **图覆盖缺口** 以下变更源码未入图：${list(missing)}。`);
  if (unresolved.length) risks.push(`- **未解析的相对导入** ${list(unresolved)}。`);
  output.push('', '**风险复核**', '', ...(risks.length ? risks : ['- 此比较区间未命中已配置的风险规则。']), '');
  return output;
}

const head = process.argv[3] ?? git('rev-parse', 'HEAD').trim();
if (!sha.test(head)) throw Error('candidate must be a full commit SHA');
const base = process.argv[2] ?? process.env.IMPACT_BASE_SHA;
const branch = process.env.IMPACT_TARGET_BRANCH;
const ranges = [];
const output = [
  '## Server 变更影响报告',
  '',
  '本报告依据静态导入（含类型引用）和文件规则，角色仅供复核。动态调用、SQL、队列和外部契约需结合源码及现有测试核对。',
  '',
];
const validBase = hasBase(base, head);
if (validBase) {
  ranges.push({ title: '本次提交差异', base, head, changes: diff(base, head) });
} else {
  output.push('- 提交比较基准缺失或不是候选的祖先，无法生成该范围。', '');
}

if (branch === 'test' && (!validBase || ranges[0].changes.some(change => change.path === planPath))) {
  let plan;
  try {
    plan = loadPlan(head);
  } catch {
    output.push('- 无法读取候选提交的发布清单。', '');
  }
  if (plan && hasBase(plan.baseRevision, head)) {
    const title = '发布清单声明的累计差异';
    output.push('- 累计差异使用清单声明的 SHA，实际部署基准由现有发布流程核验。', '');
    if (plan.baseRevision === base && validBase) Object.assign(ranges[0], { title: '本次提交和发布清单差异（同基准）', plan });
    else ranges.push({ title, base: plan.baseRevision, head, changes: diff(plan.baseRevision, head), plan });
  } else if (plan) {
    output.push('- 发布清单声明的基准不可用或不是候选的祖先。', '');
  }
}

if (ranges.length) {
  const currentGraph = await archivedGraph(head);
  for (const range of ranges) output.push(...await describe(range, currentGraph));
}
const report = output.join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
else process.stdout.write(report);
