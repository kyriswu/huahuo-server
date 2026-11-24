import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const launcher = fileURLToPath(new URL('../../deploy/local/run.mjs', import.meta.url));
const apiUrl = 'postgresql://huahuo_api:example@127.0.0.1:15432/huahuo';
const redisUrl = 'redis://127.0.0.1:16379/0';
const runtime = `DATABASE_URL=${apiUrl}\nREDIS_CACHE_URL=${redisUrl}\nREDIS_QUEUE_URL=${redisUrl}\n`;
const entrypointStub = `console.log(JSON.stringify({
  role: process.env.SERVICE_ROLE, host: process.env.HOST, port: process.env.PORT,
  database: new URL(process.env.DATABASE_URL).username,
  parser: process.env.PROCESSING_NODES_ENABLED,
  cloudControl: process.env.PROCESSING_NODES_CLOUD_CONTROL_ENABLED,
  inheritedRag: Object.hasOwn(process.env, 'RAG_PROVIDER_MODE'),
  inheritedWebhook: Object.hasOwn(process.env, 'SMS_FEISHU_WEBHOOK_URL'),
}));`;
const preload = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.includes('/src/entrypoints/')) {
    return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(entrypointStub))}, shortCircuit: true };
  }
  return next(specifier, context);
} });`;

function launch(config: string, role = 'api') {
  const directory = mkdtempSync(join(tmpdir(), 'huahuo-local-run-'));
  try {
    writeFileSync(join(directory, '.env.host'), config);
    return spawnSync(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), launcher, role], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        PATH: process.env.PATH,
        RAG_PROVIDER_MODE: 'live',
        SMS_FEISHU_WEBHOOK_URL: 'https://unused.example',
        PROCESSING_NODES_ENABLED: 'true',
        PROCESSING_NODES_CLOUD_CONTROL_ENABLED: 'true',
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('host development runner', () => {
  it('uses only the selected file for application settings and defaults parser control to off', () => {
    const result = launch(runtime + `DATABASE_ADMIN_URL=${apiUrl.replace('huahuo_api', 'huahuo_admin')}\n`, 'admin');
    expect(result.status, result.error?.message || result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      role: 'admin', host: '127.0.0.1', port: '3001', database: 'huahuo_admin',
      parser: 'false', cloudControl: 'false', inheritedRag: false, inheritedWebhook: false,
    });
  });

  it('rejects a remote database and connection options that can redirect it', () => {
    for (const databaseUrl of [apiUrl.replace('127.0.0.1', 'db.example'), apiUrl + '?host=db.example']) {
      const result = launch(runtime.replace(apiUrl, databaseUrl));
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('DATABASE_URL');
    }
  });

  it('rejects a remote Redis address', () => {
    const result = launch(runtime.replace(redisUrl, redisUrl.replace('127.0.0.1', 'redis.example')));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('REDIS_CACHE_URL');
  });
});
