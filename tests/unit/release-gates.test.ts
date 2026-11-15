import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env, Role } from '../../src/config/config.js';
import { checkReleaseConfiguration, checkReleaseExternal, checkReleaseRuntime, runDatabaseAssertions } from '../../src/release/gates.js';
import { readReleasePlan, type ReleasePlan } from '../../src/release/plan.js';
import { env } from '../helpers.js';

let root: string, plan: ReleasePlan;
const production: Env = { ...env, APP_ENV: 'production', DATABASE_SSL_MODE: 'verify-full',
  APP_PUBLIC_BASE_URL: 'https://api.example.invalid', ADMIN_PUBLIC_BASE_URL: 'https://admin.example.invalid',
  APP_JWT_PRIVATE_KEY: 'cA==', APP_JWT_PUBLIC_KEY: 'cA==' };
async function readFixture(): Promise<ReleasePlan> {
  await writeFile(join(root, 'scripts/release/plan.json'), JSON.stringify(plan));
  return readReleasePlan(root);
}

describe('release gate configuration and local child-process fixtures (no database or cloud)', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huahuo-release-gate-unit-'));
    await mkdir(join(root, 'scripts/release/changes/gate-test'), { recursive: true });
    plan = { version: 1, id: 'gate-test', baseRevision: '1'.repeat(40), services: ['api-server', 'worker', 'scheduler', 'admin'],
      database: { migrations: [], verifySql: null, dataChange: { mode: 'none', reason: '' } },
      configuration: { mode: 'reuse', changes: [], reviewedFiles: [] }, dependencies: [],
      backfill: { required: false, reference: null }, compatibility: { database: true, api: true, tasks: true, configuration: true }, smoke: 'authenticated' };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it.each(['api-server', 'admin', 'worker', 'scheduler', 'migrate'] as Role[])('refuses production health-only acceptance for %s', async role => {
    plan.smoke = 'health';
    expect(() => checkReleaseConfiguration(plan, role, production)).toThrow('RELEASE_AUTHENTICATED_SMOKE_REQUIRED');
    plan.smoke = 'authenticated';
    expect(checkReleaseConfiguration(await readFixture(), role, production).appEnv).toBe('production');
  });
  it('permits explicitly reviewed test health acceptance', async () => {
    plan.smoke = 'health'; expect(checkReleaseConfiguration(await readFixture(), 'api-server', env).appEnv).toBe('test');
  });
  it.each(['database', 'api', 'tasks', 'configuration'] as const)('blocks incompatible %s before loading or using runtime configuration', async key => {
    plan.compatibility[key] = false;
    const parsed = await readFixture();
    expect(() => checkReleaseConfiguration(parsed, 'migrate', {})).toThrow('RELEASE_PLAN_INCOMPATIBLE');
  });
  it.each([undefined, '', ' \t '])('requires a declared non-default value in the actual target role environment: %j', async value => {
    plan.configuration.mode = 'candidate';
    plan.configuration.changes = [{ key: 'RELEASE_REQUIRED_VALUE', operation: 'add', roles: ['api-server'], required: true, hasDefault: false }];
    const parsed = await readFixture();
    expect(() => checkReleaseConfiguration(parsed, 'api-server', { ...env, RELEASE_REQUIRED_VALUE: value })).toThrow('RELEASE_CONFIGURATION_MISSING');
    expect(checkReleaseConfiguration(parsed, 'api-server', { ...env, RELEASE_REQUIRED_VALUE: 'configured-only-in-target-env' }).role).toBe('api-server');
    expect(checkReleaseConfiguration(parsed, 'worker', env).role).toBe('worker');
  });
  it('does not require removed, optional or reviewed defaulted values to be injected', async () => {
    plan.configuration.mode = 'candidate';
    plan.configuration.changes = [
      { key: 'REMOVED_VALUE', operation: 'remove', roles: ['api-server'], required: true, hasDefault: false },
      { key: 'OPTIONAL_VALUE', operation: 'add', roles: ['api-server'], required: false, hasDefault: false },
      { key: 'DEFAULT_VALUE', operation: 'add', roles: ['api-server'], required: true, hasDefault: true },
    ];
    expect(checkReleaseConfiguration(await readFixture(), 'api-server', env).role).toBe('api-server');
  });
  it('retains application configuration validation and does not leak invalid values', async () => {
    const parsed = await readFixture();
    expect(() => checkReleaseConfiguration(parsed, 'api-server', { ...env, DATABASE_URL: 'do-not-log-secret-url' })).toThrow('INVALID_CONFIG:DATABASE_URL');
  });
  it('refuses the migration role for runtime readiness before opening dependencies', async () => {
    const config = checkReleaseConfiguration(await readFixture(), 'migrate', env);
    await expect(checkReleaseRuntime(config, root)).rejects.toThrow('RELEASE_RUNTIME_ROLE_REQUIRED');
  });
  it.each(['   ', 'x'.repeat(128 * 1024 + 1)])('rejects an empty or oversized assertion before opening a database', async sql => {
    const config = checkReleaseConfiguration(await readFixture(), 'migrate', env);
    await expect(runDatabaseAssertions(config, sql)).rejects.toThrow('RELEASE_DB_ASSERTIONS_INVALID');
  });
  it('executes only the declared local external-check fixture and captures its output', async () => {
    plan.dependencies = [{ name: 'fixture', checkFile: 'scripts/release/changes/gate-test/verify-external.mjs' }];
    await writeFile(join(root, plan.dependencies[0]!.checkFile), 'console.log("synthetic-private-check-output");');
    await expect(checkReleaseExternal(await readFixture(), root)).resolves.toEqual({ checkCount: 1 });
    await writeFile(join(root, plan.dependencies[0]!.checkFile), 'console.error("synthetic-private-check-error");process.exitCode=1;');
    await expect(checkReleaseExternal(await readFixture(), root)).rejects.toThrow(/^RELEASE_EXTERNAL_CHECK_FAILED$/);
  });
  it('runs one reviewed check file once when it covers several named dependencies', async () => {
    const checkFile = 'scripts/release/changes/gate-test/verify-external.mjs';
    plan.dependencies = [{ name: 'first', checkFile }, { name: 'second', checkFile }];
    await writeFile(join(root, checkFile), "import {appendFileSync} from 'node:fs';appendFileSync(new URL('./calls.txt',import.meta.url),'called\\n');");
    await expect(checkReleaseExternal(await readFixture(), root)).resolves.toEqual({ checkCount: 2 });
    expect(await readFile(join(root, 'scripts/release/changes/gate-test/calls.txt'), 'utf8')).toBe('called\n');
  });
});
