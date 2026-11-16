import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Env, Role } from '../../src/config/config.js';
import { checkReleaseConfiguration, reviewReleaseConfiguration, checkReleaseConfigurationAssertions, checkReleaseExternal, checkReleaseRuntime, runDatabaseAssertions } from '../../src/release/gates.js';
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
    expect(reviewReleaseConfiguration(parsed, 'migrate', env).role).toBe('migrate');
    expect(() => reviewReleaseConfiguration(parsed, 'migrate', { ...env, DATABASE_URL: 'invalid' })).toThrow('INVALID_CONFIG:DATABASE_URL');
  });
  it('read-only incompatible candidate inspection retains required configuration checks', async () => {
    plan.compatibility.configuration = false;
    plan.configuration.mode = 'candidate';
    plan.configuration.changes = [{ key: 'REQUIRED_VALUE', operation: 'add', roles: ['api-server'], required: true, hasDefault: false }];
    expect(() => reviewReleaseConfiguration(plan, 'api-server', env)).toThrow('RELEASE_CONFIGURATION_MISSING');
    expect(reviewReleaseConfiguration(plan, 'api-server', { ...env, REQUIRED_VALUE: 'fixture' }).role).toBe('api-server');
  });
  it('the configuration CLI reports a read-only pass without claiming automatic deployment readiness', async () => {
    plan.compatibility.api = false; await readFixture();
    const args = ['--disable-warning=DEP0205', '--import', createRequire(import.meta.url).resolve('tsx'),
      resolve('src/entrypoints/release-gate.ts')];
    const options = { cwd: root, env: { ...env, SERVICE_ROLE: 'api-server', PATH: process.env.PATH },
      encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    expect(JSON.parse(execFileSync(process.execPath, [...args, 'config'], options)))
      .toMatchObject({ status: 'passed', stage: 'config', automaticReleaseReady: false, result: { checkCount: 0 } });
    expect(() => execFileSync(process.execPath, [...args, 'deploy'], options)).toThrow();
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
  it('checks changed values in each actual role and suppresses private failure output', async () => {
    plan.configuration.mode = 'candidate';
    plan.configuration.verifyFile = 'scripts/release/changes/gate-test/verify-config.mjs';
    plan.configuration.changes = [{ key: 'FEATURE_BUDGET', operation: 'change', roles: ['worker'], required: true, hasDefault: false }];
    await writeFile(join(root, plan.configuration.verifyFile), `if (process.env.SERVICE_ROLE === 'worker' && process.env.FEATURE_BUDGET !== '20') { console.error(process.env.FEATURE_BUDGET); throw Error('private-fixture-detail'); }`);
    const parsed = await readFixture();
    await expect(checkReleaseConfigurationAssertions(parsed, 'worker', { ...env, FEATURE_BUDGET: '10' }, root)).rejects.toThrow(/^RELEASE_CONFIGURATION_ASSERTION_FAILED$/);
    await expect(checkReleaseConfigurationAssertions(parsed, 'worker', { ...env, FEATURE_BUDGET: '20' }, root)).resolves.toEqual({ checkCount: 1 });
    await expect(checkReleaseConfigurationAssertions(parsed, 'api-server', env, root)).resolves.toEqual({ checkCount: 1 });
  });
  it('rejects missing or overlong configuration check scripts', async () => {
    plan.configuration.verifyFile = 'scripts/release/changes/gate-test/verify-config.mjs';
    const parsed = await readFixture();
    await expect(checkReleaseConfigurationAssertions(parsed, 'worker', env, root)).rejects.toThrow('RELEASE_CONFIGURATION_ASSERTION_FAILED');
    await writeFile(join(root, plan.configuration.verifyFile), ' '.repeat(65537));
    await expect(checkReleaseConfigurationAssertions(parsed, 'worker', env, root)).rejects.toThrow('RELEASE_CONFIGURATION_ASSERTION_FAILED');
  });
  it('bounds a stalled configuration assertion', async () => {
    plan.configuration.verifyFile = 'scripts/release/changes/gate-test/verify-config.mjs';
    await writeFile(join(root, plan.configuration.verifyFile), 'setInterval(() => {}, 1000);');
    await expect(checkReleaseConfigurationAssertions(await readFixture(), 'worker', env, root)).rejects.toThrow('RELEASE_CONFIGURATION_ASSERTION_FAILED');
  }, 7000);
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
