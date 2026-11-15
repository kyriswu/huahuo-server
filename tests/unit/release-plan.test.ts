import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReleasePlan, ReleasePlanError, validateReleasePlan, type ReleasePlan } from '../../src/release/plan.js';

let root: string, base: string, plan: ReleasePlan;
function git(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}
function commit(): string { git('add', '--all'); git('commit', '--quiet', '-m', 'fixture'); return git('rev-parse', 'HEAD'); }
async function save(): Promise<void> { await put('scripts/release/plan.json', JSON.stringify(plan)); }
async function verifyFile(): Promise<void> {
  plan.database.verifySql = `scripts/release/changes/${plan.id}/verify-db.sql`;
  await put(plan.database.verifySql, 'SELECT true AS passed;\n');
}

describe('reviewed release plan', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huahuo-release-plan-'));
    git('init', '--quiet'); git('config', 'user.email', 'release-fixture@example.invalid'); git('config', 'user.name', 'Release fixture');
    await put('migrations/0001_initial_schema.sql', 'CREATE TABLE fixture(id integer);\n');
    await put('.env.example', 'APP_ENV=test\n');
    await put('compose.yaml', 'services: {}\n');
    base = commit();
    plan = { version: 1, id: 'test-release', baseRevision: base, services: ['api-server', 'worker', 'scheduler', 'admin'],
      database: { migrations: [], verifySql: null, dataChange: { mode: 'none', reason: '' } },
      configuration: { mode: 'reuse', changes: [], reviewedFiles: [] }, dependencies: [],
      backfill: { required: false, reference: null }, compatibility: { database: true, api: true, tasks: true, configuration: true }, smoke: 'authenticated' };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('accepts a code-only release and reports only bounded metadata', async () => {
    await put('src/app.ts', 'export const version = 2;\n'); const revision = commit(); await save();
    expect(await validateReleasePlan(await readReleasePlan(root), root)).toEqual({ id: plan.id, baseRevision: base, revision,
      migrationCount: 0, changedFileCount: 1, serviceCount: 4, smoke: 'authenticated' });
  });
  it('permits a test health plan without interpreting it as production approval', async () => {
    plan.smoke = 'health'; expect((await validateReleasePlan(plan, root)).smoke).toBe('health');
  });
  it('requires every cumulative migration since the deployed base, not just the latest commit', async () => {
    await put('migrations/0002_first.sql', 'SELECT 1;'); commit();
    await put('migrations/0003_second.sql', 'SELECT 2;'); await verifyFile(); commit();
    plan.database.migrations = ['0003_second.sql'];
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_MIGRATIONS_MISMATCH');
    plan.database.migrations = ['0003_second.sql', '0002_first.sql'];
    expect((await validateReleasePlan(plan, root)).migrationCount).toBe(2);
  });
  it.each(['edit', 'delete', 'rename'])('freezes historical SQL against %s', async change => {
    if (change === 'edit') await put('migrations/0001_initial_schema.sql', 'SELECT 1;');
    if (change === 'delete') await rm(join(root, 'migrations/0001_initial_schema.sql'));
    if (change === 'rename') git('mv', 'migrations/0001_initial_schema.sql', 'migrations/0001_renamed.sql');
    commit(); await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_MIGRATION_HISTORY_CHANGED');
  });
  it('rejects duplicate migration numbers in candidate files', async () => {
    await put('migrations/0002_a.sql', 'SELECT 1;'); await put('migrations/0002_b.sql', 'SELECT 2;'); commit();
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_INVALID');
  });
  it('rejects newly inserted older migration numbers', async () => {
    await put('migrations/0003_old.sql', 'SELECT 3;'); plan.baseRevision = commit();
    await put('migrations/0002_late.sql', 'SELECT 2;'); commit(); plan.database.migrations = ['0002_late.sql'];
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_MIGRATIONS_MISMATCH');
  });
  it('rejects a manifest migration that is absent from the candidate', async () => {
    plan.database.migrations = ['0002_absent.sql'];
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_MIGRATIONS_MISMATCH');
  });
  it('requires verification SQL for a new migration', async () => {
    await put('migrations/0002_new.sql', 'SELECT 1;'); commit(); plan.database.migrations = ['0002_new.sql'];
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_DB_VERIFICATION_REQUIRED');
  });
  it.each(['src/db/schema.ts', 'src/modules/users/repository.ts', 'src/repositories/users.ts'])('requires SQL verification when %s changes without SQL', async path => {
    await put(path, 'export const query = true;'); commit();
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_DB_VERIFICATION_REQUIRED');
    await verifyFile(); expect((await validateReleasePlan(plan, root)).migrationCount).toBe(0);
  });
  it.each(['.env.example', 'compose.yaml', 'src/config/config.ts'])('requires explicit review of changed config path %s', async path => {
    await put(path, '# candidate configuration\n'); commit();
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_CONFIG_REVIEW_REQUIRED');
    plan.configuration.reviewedFiles = [path]; await expect(validateReleasePlan(plan, root)).resolves.toMatchObject({ id: plan.id });
  });
  it('allows declared config changes only with a separately prepared candidate', async () => {
    plan.configuration.changes.push({ key: 'NEW_FEATURE', operation: 'add', roles: ['api-server', 'migrate'], required: true, hasDefault: false });
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_INVALID');
    plan.configuration.mode = 'candidate'; await expect(validateReleasePlan(plan, root)).resolves.toMatchObject({ id: plan.id });
  });
  it('reuses actual environment values for an added optional variable with a reviewed default', async () => {
    plan.configuration.changes.push({ key: 'OPTIONAL_BUDGET', operation: 'add', roles: ['migrate'], required: false, hasDefault: true });
    await expect(validateReleasePlan(plan, root)).resolves.toMatchObject({ id: plan.id });
    plan.configuration.changes[0]!.operation = 'change';
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_INVALID');
  });
  it('reuses the successful ENV snapshot after reviewed code stops reading optional retired keys', async () => {
    await put('src/config/config.ts', 'export const timeout = process.env.SHUTDOWN_TIMEOUT_MS;\n');
    await put('compose.yaml', 'services:\n  worker:\n    stop_grace_period: ${STOP_GRACE_PERIOD}\n');
    const snapshot = 'SHUTDOWN_TIMEOUT_MS=300000\nSTOP_GRACE_PERIOD=330s\n';
    await put('successful.env', snapshot);
    plan.baseRevision = commit();
    await put('src/config/config.ts', "export const timeoutSource = 'database-setting';\n");
    await put('compose.yaml', 'services:\n  worker: {}\n');
    commit();
    plan.configuration.changes = ['SHUTDOWN_TIMEOUT_MS', 'STOP_GRACE_PERIOD'].map(key => ({
      key, operation: 'remove', roles: ['worker'], required: false, hasDefault: false,
    }));
    await save();
    await expect(validateReleasePlan(await readReleasePlan(root), root)).rejects.toThrow('RELEASE_PLAN_CONFIG_REVIEW_REQUIRED');
    plan.configuration.reviewedFiles = ['src/config/config.ts', 'compose.yaml'];
    await save();
    await expect(validateReleasePlan(await readReleasePlan(root), root)).resolves.toMatchObject({ id: plan.id });
    expect(await readFile(join(root, 'successful.env'), 'utf8')).toBe(snapshot);
  });
  it.each([false, true])('still requires candidate ENV for a required removal, hasDefault=%s', async hasDefault => {
    plan.configuration.changes = [{ key: 'REQUIRED_VALUE', operation: 'remove', roles: ['worker'], required: true, hasDefault }];
    await save();
    await expect(readReleasePlan(root)).rejects.toThrow('RELEASE_PLAN_INVALID');
    plan.configuration.mode = 'candidate';
    await save();
    await expect(validateReleasePlan(await readReleasePlan(root), root)).resolves.toMatchObject({ id: plan.id });
  });
  it('accepts reviewed small inline data changes without a blanket SQL/DML ban', async () => {
    await put('migrations/0002_config_fix.sql', 'UPDATE fixture SET id=2 WHERE id=1;'); await verifyFile(); commit();
    plan.database.migrations = ['0002_config_fix.sql']; plan.database.dataChange = { mode: 'inline', reason: 'Reviewed bounded startup configuration correction.' };
    expect((await validateReleasePlan(plan, root)).migrationCount).toBe(1);
  });
  it('records separate backfill instructions without executing them', async () => {
    plan.database.dataChange = { mode: 'separate', reason: 'Large historical data correction reviewed separately.' };
    plan.backfill = { required: true, reference: 'docs/backfill.md' }; await put('docs/backfill.md', 'Plan only; no execution.');
    await expect(validateReleasePlan(plan, root)).resolves.toMatchObject({ id: plan.id });
  });
  it.each(['database', 'api', 'tasks', 'configuration'] as const)('blocks automatic release with incompatible %s', async key => {
    plan.compatibility[key] = false; await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_INCOMPATIBLE');
  });
  it('rejects unknown and divergent deployed baselines', async () => {
    plan.baseRevision = 'f'.repeat(40); await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_BASE_INVALID');
    await put('first.txt', 'one'); const branch = commit(); git('checkout', '--quiet', '--detach', base);
    await put('other.txt', 'two'); commit(); plan.baseRevision = branch;
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_BASE_INVALID');
  });
  it('uses the full candidate merge diff', async () => {
    git('checkout', '--quiet', '-b', 'candidate'); await put('src/db/repository.ts', 'export const changed = true;'); commit();
    git('checkout', '--quiet', '-b', 'target', base); await put('other.txt', 'unrelated target change'); commit();
    git('merge', '--no-ff', '--quiet', '-m', 'candidate merge', 'candidate');
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_DB_VERIFICATION_REQUIRED');
  });
  it('does not treat uncommitted business edits as a verified candidate', async () => {
    await put('migrations/0002_uncommitted.sql', 'SELECT 1;'); plan.database.migrations = ['0002_uncommitted.sql'];
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_MIGRATIONS_MISMATCH');
  });
  it('requires readable referenced verification and dependency files', async () => {
    plan.database.verifySql = `scripts/release/changes/${plan.id}/verify-db.sql`;
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_FILE_INVALID'); await verifyFile();
    plan.dependencies = [{ name: 'parser', checkFile: `scripts/release/changes/${plan.id}/verify-external.mjs` }];
    await expect(validateReleasePlan(plan, root)).rejects.toThrow('RELEASE_PLAN_FILE_INVALID');
    await put(plan.dependencies[0]!.checkFile, 'throw new Error("must never execute");');
    await expect(validateReleasePlan(plan, root)).resolves.toMatchObject({ id: plan.id });
  });
  it('rejects symlink plan files', async () => {
    await save(); git('add', '--all'); await rm(join(root, 'scripts/release/plan.json'));
    await put('other.json', JSON.stringify(plan)); await symlink('../../other.json', join(root, 'scripts/release/plan.json'));
    await expect(readReleasePlan(root)).rejects.toThrow('RELEASE_PLAN_FILE_INVALID');
  });
  it.each([
    ['unknown field', (p: ReleasePlan) => Object.assign(p, { token: 'secret-value' })],
    ['invalid id', (p: ReleasePlan) => { p.id = '../bad'; }],
    ['mutable base', (p: ReleasePlan) => { p.baseRevision = 'main'; }],
    ['empty services', (p: ReleasePlan) => { p.services = []; }],
    ['duplicate services', (p: ReleasePlan) => { p.services = ['worker', 'worker']; }],
    ['unknown service', (p: ReleasePlan) => Object.assign(p, { services: ['foreign-service'] })],
    ['migration traversal', (p: ReleasePlan) => { p.database.migrations = ['../0002_bad.sql']; }],
    ['duplicate migration', (p: ReleasePlan) => { p.database.migrations = ['0002_a.sql', '0002_a.sql']; }],
    ['wrong verification path', (p: ReleasePlan) => { p.database.verifySql = 'docs/verify.sql'; }],
    ['config secret', (p: ReleasePlan) => Object.assign(p.configuration, { value: 'secret-value' })],
    ['review traversal', (p: ReleasePlan) => { p.configuration.reviewedFiles = ['../.env']; }],
    ['missing data reason', (p: ReleasePlan) => { p.database.dataChange = { mode: 'inline', reason: '  ' }; }],
    ['separate without reference', (p: ReleasePlan) => { p.database.dataChange = { mode: 'separate', reason: 'large' }; }],
    ['backfill for inline', (p: ReleasePlan) => { p.database.dataChange = { mode: 'inline', reason: 'small' }; p.backfill = { required: true, reference: 'docs/task.md' }; }],
    ['script as backfill', (p: ReleasePlan) => { p.database.dataChange = { mode: 'separate', reason: 'large' }; p.backfill = { required: true, reference: 'scripts/task.sh' }; }],
    ['external arbitrary script', (p: ReleasePlan) => { p.dependencies = [{ name: 'parser', checkFile: 'scripts/arbitrary.mjs' }]; }],
    ['unknown smoke', (p: ReleasePlan) => Object.assign(p, { smoke: 'skip' })],
  ])('rejects schema error: %s', async (_name, mutate) => {
    mutate(plan); await save(); await expect(readReleasePlan(root)).rejects.toBeInstanceOf(ReleasePlanError);
  });
  it('rejects malformed or oversized JSON without exposing its content', async () => {
    await put('scripts/release/plan.json', '{secret-value'); await expect(readReleasePlan(root)).rejects.toThrow('RELEASE_PLAN_INVALID');
    await put('scripts/release/plan.json', 's'.repeat(65537)); await expect(readReleasePlan(root)).rejects.toThrow('RELEASE_PLAN_FILE_INVALID');
  });
  it('CLI emits a fixed failure and exits nonzero', async () => {
    await put('scripts/release/plan.json', '{secret-value');
    let result: { stdout?: string | Buffer; stderr?: string | Buffer; status?: number } = {};
    try { execFileSync(process.execPath, ['--disable-warning=DEP0205', '--import', 'tsx', resolve('src/entrypoints/release-plan.ts'), '--root', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { result = error as typeof result; }
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(String(result.stderr))).toEqual({ status: 'failed', code: 'RELEASE_PLAN_INVALID' });
  });
  it('CLI refuses an uncommitted candidate, then accepts the same clean committed tree', async () => {
    await save();
    // tsx uses Node's deprecated loader API; production runs compiled JS.
    const args = ['--disable-warning=DEP0205', '--import', 'tsx', resolve('src/entrypoints/release-plan.ts'), '--root', root];
    let errorText = '';
    try { execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { errorText = String((error as { stderr: string }).stderr); }
    expect(JSON.parse(errorText).code).toBe('RELEASE_PLAN_WORKTREE_DIRTY');
    commit();
    expect(JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).status).toBe('passed');
    await put('src/new-uncommitted.ts', 'export const hidden = true;');
    expect(() => execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
  });
});
