import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runtimeRoles = ['api-server', 'admin', 'worker', 'scheduler'] as const;
const baselineMigration = '0001_initial_schema.sql';
// This is the sole predecessor authorized for the local-only baseline consolidation.
const freshBaselinePredecessor = '65e03b27afcbd97876db4c08ef01df754b9426dc';
type RuntimeRole = typeof runtimeRoles[number];
type Role = RuntimeRole | 'migrate';
export interface ReleasePlan {
  version: 1;
  id: string;
  baseRevision: string;
  services: RuntimeRole[];
  database: {
    migrations: string[];
    verifySql: string | null;
    dataChange: { mode: 'none' | 'inline' | 'separate'; reason: string };
    bootstrap?: 'fresh-only';
  };
  configuration: {
    mode: 'reuse' | 'candidate';
    changes: { key: string; operation: 'add' | 'change' | 'remove'; roles: Role[]; required: boolean; hasDefault: boolean }[];
    reviewedFiles: string[];
    verifyFile?: string;
  };
  dependencies: { name: string; checkFile: string }[];
  backfill: { required: boolean; reference: string | null };
  compatibility: { database: boolean; api: boolean; tasks: boolean; configuration: boolean };
  smoke: 'health' | 'authenticated';
}
export interface ReleasePlanSummary {
  id: string;
  baseRevision: string;
  revision: string;
  migrationCount: number;
  changedFileCount: number;
  serviceCount: number;
  smoke: ReleasePlan['smoke'];
  automaticReleaseReady: boolean;
}
type ErrorCode = 'RELEASE_PLAN_INVALID' | 'RELEASE_PLAN_FILE_INVALID' | 'RELEASE_PLAN_GIT_FAILED'
  | 'RELEASE_PLAN_BASE_INVALID' | 'RELEASE_PLAN_MIGRATION_HISTORY_CHANGED'
  | 'RELEASE_PLAN_MIGRATIONS_MISMATCH' | 'RELEASE_PLAN_DB_VERIFICATION_REQUIRED'
  | 'RELEASE_PLAN_CONFIG_REVIEW_REQUIRED' | 'RELEASE_PLAN_INCOMPATIBLE' | 'RELEASE_PLAN_WORKTREE_DIRTY';
export class ReleasePlanError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'ReleasePlanError'; }
}
function fail(code: ErrorCode = 'RELEASE_PLAN_INVALID'): never { throw new ReleasePlanError(code); }
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) fail();
  return record;
}
function uniqueStrings(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length) fail();
  return value;
}
function repositoryPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 240 && !isAbsolute(value)
    && /^[a-zA-Z0-9_.\-/]+$/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');
}
function parsePlan(input: unknown): ReleasePlan {
  const plan = object(input, ['version', 'id', 'baseRevision', 'services', 'database', 'configuration', 'dependencies', 'backfill', 'compatibility', 'smoke']);
  if (plan.version !== 1 || typeof plan.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.id)
    || typeof plan.baseRevision !== 'string' || !/^[a-f0-9]{40}$/.test(plan.baseRevision)) fail();
  const roles = uniqueStrings(plan.services, 4);
  if (!roles.length || roles.some(role => !runtimeRoles.includes(role as RuntimeRole))) fail();
  const database = object(plan.database, ['migrations', 'verifySql', 'dataChange',
    ...(plan.database && typeof plan.database === 'object' && Object.hasOwn(plan.database, 'bootstrap') ? ['bootstrap'] : [])]);
  if (Object.hasOwn(database, 'bootstrap') && database.bootstrap !== 'fresh-only') fail();
  const migrations = uniqueStrings(database.migrations, 9999);
  if (migrations.some(name => !/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(name))
    || new Set(migrations.map(name => name.slice(0, 4))).size !== migrations.length) fail();
  // Start with explicit role selection for ordinary code/config releases.
  // Schema upgrades keep the existing full-role handover until separately reviewed.
  if (migrations.length && roles.length !== runtimeRoles.length) fail();
  if (database.verifySql !== null && database.verifySql !== `scripts/release/changes/${plan.id}/verify-db.sql`) fail();
  const dataChange = object(database.dataChange, ['mode', 'reason']);
  if (!['none', 'inline', 'separate'].includes(String(dataChange.mode)) || typeof dataChange.reason !== 'string'
    || dataChange.reason.length > 2000 || (dataChange.mode !== 'none' && !dataChange.reason.trim())) fail();
  const configuration = object(plan.configuration, ['mode', 'changes', 'reviewedFiles',
    ...(plan.configuration && typeof plan.configuration === 'object' && Object.hasOwn(plan.configuration, 'verifyFile') ? ['verifyFile'] : [])]);
  if (configuration.verifyFile !== undefined && configuration.verifyFile !== `scripts/release/changes/${plan.id}/verify-config.mjs`) fail();
  if (!['reuse', 'candidate'].includes(String(configuration.mode)) || !Array.isArray(configuration.changes) || configuration.changes.length > 512) fail();
  const keys = new Set<string>();
  for (const item of configuration.changes) {
    const change = object(item, ['key', 'operation', 'roles', 'required', 'hasDefault']);
    if (typeof change.key !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(change.key) || keys.has(change.key)
      || !['add', 'change', 'remove'].includes(String(change.operation))
      || typeof change.required !== 'boolean' || typeof change.hasDefault !== 'boolean') fail();
    keys.add(change.key);
    const requiredRoles = uniqueStrings(change.roles, 5);
    if (!requiredRoles.length || requiredRoles.some(role => ![...runtimeRoles, 'migrate'].includes(role))) fail();
    if ((change.operation !== 'remove' || change.required)
      && requiredRoles.some(role => role !== 'migrate' && !roles.includes(role))) fail();
  }
  if (configuration.mode !== 'candidate' && configuration.changes.some(item =>
    !((item.operation === 'add' && item.hasDefault) || (item.operation === 'remove' && !item.required)))) fail();
  if (configuration.changes.some(item => item.operation === 'change') && !configuration.verifyFile) fail();
  if (uniqueStrings(configuration.reviewedFiles, 512).some(path => !repositoryPath(path))) fail();
  if (!Array.isArray(plan.dependencies) || plan.dependencies.length > 64) fail();
  const names = new Set<string>();
  for (const item of plan.dependencies) {
    const dependency = object(item, ['name', 'checkFile']);
    if (typeof dependency.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(dependency.name) || names.has(dependency.name)
      || dependency.checkFile !== `scripts/release/changes/${plan.id}/verify-external.mjs`) fail();
    names.add(dependency.name);
  }
  const backfill = object(plan.backfill, ['required', 'reference']);
  if (typeof backfill.required !== 'boolean' || (backfill.required
    ? !repositoryPath(backfill.reference) || !backfill.reference.startsWith('docs/') || !backfill.reference.endsWith('.md')
    : backfill.reference !== null)) fail();
  if (backfill.required !== (dataChange.mode === 'separate')) fail();
  const compatibility = object(plan.compatibility, ['database', 'api', 'tasks', 'configuration']);
  if (Object.values(compatibility).some(value => typeof value !== 'boolean')) fail();
  if (database.bootstrap === 'fresh-only' && (plan.baseRevision !== freshBaselinePredecessor
    || migrations.length !== 1 || migrations[0] !== baselineMigration || database.verifySql === null
    || dataChange.mode !== 'inline' || compatibility.database !== false)) fail();
  if (plan.smoke !== 'health' && plan.smoke !== 'authenticated') fail();
  return plan as unknown as ReleasePlan;
}
async function file(root: string, path: string, maxBytes = 512 * 1024): Promise<string> {
  try {
    if (!repositoryPath(path)) fail('RELEASE_PLAN_FILE_INVALID');
    const absolute = resolve(root, path);
    const stat = await lstat(absolute);
    const actual = relative(root, await realpath(absolute));
    if (!stat.isFile() || stat.size > maxBytes || actual.startsWith('..') || isAbsolute(actual)) fail('RELEASE_PLAN_FILE_INVALID');
    return await readFile(absolute, 'utf8');
  } catch { fail('RELEASE_PLAN_FILE_INVALID'); }
}
/** Reads the reviewed plan only. Does not execute SQL, external checks or configuration. */
export async function readReleasePlan(root = process.cwd()): Promise<ReleasePlan> {
  try { return parsePlan(JSON.parse(await file(await realpath(root), 'scripts/release/plan.json', 64 * 1024))); }
  catch (error) { if (error instanceof ReleasePlanError) throw error; fail(); }
}
async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
    return result.stdout;
  } catch { fail('RELEASE_PLAN_GIT_FAILED'); }
}
async function migrationsAt(root: string, revision: string): Promise<Map<string, string>> {
  const entries = (await git(root, ['ls-tree', '-rz', '--full-tree', revision, '--', 'migrations'])).split('\0').filter(Boolean);
  const files = new Map<string, string>(), versions = new Set<string>();
  for (const entry of entries) {
    const [metadata, path] = entry.split('\t');
    if (!path?.endsWith('.sql')) continue;
    const [mode, type, hash] = metadata!.split(' ');
    if (!/^migrations\/[0-9]{4}_[a-z0-9_]+\.sql$/.test(path) || type !== 'blob' || !['100644', '100755'].includes(mode!) || !hash) fail();
    const name = path.slice('migrations/'.length), version = name.slice(0, 4);
    if (versions.has(version) || version === '0000') fail();
    versions.add(version); files.set(name, hash);
  }
  return files;
}
/** Reviews committed candidate HEAD against its deployed base; this does not authorize deployment. */
export async function reviewReleasePlan(input: ReleasePlan, root = process.cwd()): Promise<ReleasePlanSummary> {
  const plan = parsePlan(input);
  root = await realpath(root);
  if (await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim()) !== root) fail('RELEASE_PLAN_GIT_FAILED');
  const revision = (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  try { await git(root, ['merge-base', '--is-ancestor', plan.baseRevision, revision]); }
  catch { fail('RELEASE_PLAN_BASE_INVALID'); }
  const changed = (await git(root, ['diff', '--no-renames', '--name-only', '-z', plan.baseRevision, revision, '--'])).split('\0').filter(Boolean);
  const [before, after] = await Promise.all([migrationsAt(root, plan.baseRevision), migrationsAt(root, revision)]);
  let added: string[];
  if (plan.database.bootstrap === 'fresh-only') {
    const replacement = after.get(baselineMigration);
    if (before.size < 2 || after.size !== 1 || !replacement || replacement === before.get(baselineMigration)) {
      fail('RELEASE_PLAN_MIGRATIONS_MISMATCH');
    }
    // Limit the exception to the single consolidation even while the manifest still describes it.
    const resetRevision = (await git(root, ['rev-list', '--no-merges', '--full-history', `${plan.baseRevision}..${revision}`,
      '--', `migrations/${baselineMigration}`])).trim();
    if (!/^[a-f0-9]{40}$/.test(resetRevision)
      || (await migrationsAt(root, resetRevision)).get(baselineMigration) !== replacement) {
      fail('RELEASE_PLAN_MIGRATION_HISTORY_CHANGED');
    }
    added = [baselineMigration];
  } else {
    for (const [name, checksum] of before) if (after.get(name) !== checksum) fail('RELEASE_PLAN_MIGRATION_HISTORY_CHANGED');
    added = [...after.keys()].filter(name => !before.has(name)).sort();
    const highest = Math.max(0, ...[...before.keys()].map(name => Number(name.slice(0, 4))));
    if (added.some(name => Number(name.slice(0, 4)) <= highest)
      || JSON.stringify(added) !== JSON.stringify([...plan.database.migrations].sort())) fail('RELEASE_PLAN_MIGRATIONS_MISMATCH');
  }
  const databaseChanged = added.length > 0 || changed.some(path => path.startsWith('src/db/')
    || (path.startsWith('src/') && /(?:repository|repositories)/.test(path)));
  if (databaseChanged && plan.database.verifySql === null) fail('RELEASE_PLAN_DB_VERIFICATION_REQUIRED');
  const configChanged = changed.filter(path => ['.env.example', 'compose.yaml'].includes(path) || path.startsWith('src/config/'));
  if (configChanged.some(path => !plan.configuration.reviewedFiles.includes(path))) fail('RELEASE_PLAN_CONFIG_REVIEW_REQUIRED');
  if (plan.configuration.verifyFile) await file(root, plan.configuration.verifyFile, 65536);
  if (plan.database.verifySql) await file(root, plan.database.verifySql);
  for (const dependency of plan.dependencies) await file(root, dependency.checkFile);
  if (plan.backfill.reference) await file(root, plan.backfill.reference);
  return { id: plan.id, baseRevision: plan.baseRevision, revision, migrationCount: added.length,
    changedFileCount: changed.length, serviceCount: plan.services.length, smoke: plan.smoke,
    automaticReleaseReady: Object.values(plan.compatibility).every(value => value === true) };
}

/** Automatic deployment remains fail-closed, independently of successful CI review. */
export async function validateReleasePlan(input: ReleasePlan, root = process.cwd()): Promise<ReleasePlanSummary> {
  const plan = parsePlan(input);
  if (Object.values(plan.compatibility).some(value => !value)) fail('RELEASE_PLAN_INCOMPATIBLE');
  return reviewReleasePlan(plan, root);
}

/** Validate the reviewed check file without executing it. */
export async function readConfigurationCheck(plan: ReleasePlan, root: string): Promise<string | null> {
  return plan.configuration.verifyFile ? file(await realpath(root), plan.configuration.verifyFile, 65536) : null;
}
