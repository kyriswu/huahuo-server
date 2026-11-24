import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('../../deploy/local/sync-db.mjs', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const runtime = 'DATABASE_URL=postgresql://huahuo_api:example@127.0.0.1:15432/huahuo\n';
const migration = 'DATABASE_URL=postgresql://huahuo_migrator:example@127.0.0.1:15432/huahuo\n';

function verifyRejection(runtimeEnv: string, migrationEnv: string | undefined, code: string) {
  const directory = mkdtempSync(join(tmpdir(), 'huahuo-local-sync-'));
  try {
    writeFileSync(join(directory, '.env.host'), runtimeEnv);
    writeFileSync(join(directory, '.env'), 'DATABASE_URL=postgresql://cloud-user:cloud-secret@cloud.example/huahuo\n');
    if (migrationEnv !== undefined) writeFileSync(join(directory, '.env.host.migrate'), migrationEnv);
    const result = spawnSync(process.execPath, ['--import', loader, launcher, '--check'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 5000,
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://cloud-user:cloud-secret@cloud.example/huahuo' },
    });
    expect(result.status, result.error?.message || result.stderr).toBe(1);
    expect(result.stderr.split('\n')).toContain(JSON.stringify({ status: 'failed', code }));
    expect(result.stderr).not.toContain('cloud-secret');
    expect(result.stdout).toBe('');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('local database sync target protection', () => {
  it('requires a dedicated migration env even when another DATABASE_URL is available', () => {
    verifyRejection(runtime, undefined, 'LOCAL_MIGRATION_ENV_UNREADABLE');
  });

  it('rejects a cloud host and connection-string parameters that can override the host', () => {
    verifyRejection(runtime, migration.replace('127.0.0.1', 'cloud.example'), 'LOCAL_DATABASE_REQUIRES_LOOPBACK');
    verifyRejection(runtime, migration.trimEnd() + '?host=cloud.example\n', 'LOCAL_DATABASE_URL_INVALID');
  });

  it('rejects a different database or port and respects the API-specific URL', () => {
    verifyRejection(runtime, migration.replace('/huahuo\n', '/other\n'), 'LOCAL_DATABASE_TARGET_MISMATCH');
    verifyRejection(runtime, migration.replace(':15432', ':5432'), 'LOCAL_DATABASE_TARGET_MISMATCH');
    verifyRejection(runtime + runtime.replace('DATABASE_URL', 'DATABASE_API_URL').replace('/huahuo\n', '/other\n'),
      migration, 'LOCAL_DATABASE_TARGET_MISMATCH');
  });

  it('rejects a test environment or a non-migrator role', () => {
    verifyRejection(runtime, migration + 'APP_ENV=test\n', 'LOCAL_DATABASE_REQUIRES_DEVELOPMENT');
    verifyRejection(runtime, migration.replace('huahuo_migrator', 'postgres'), 'LOCAL_DATABASE_REQUIRES_MIGRATOR');
  });
});
