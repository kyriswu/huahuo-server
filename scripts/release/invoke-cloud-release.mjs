import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RetryOptions, RuntimeOptions } from '@darabonba/typescript';

// This is the explicitly authorized test ECS, never an arbitrary deployment target.
const TARGET = Object.freeze({ regionId: 'cn-beijing', instanceId: 'i-2zegtoygiiked53yntmj' });
const MAX_POLLS = 240;
const STAGES = ['preflight', 'checkout', 'build', 'migrate', 'deploy', 'health', 'cleanup', 'complete'];
const ERROR_CODES = new Set(['TEST_RELEASE_TARGET_DENIED', 'TEST_RELEASE_COMMAND_INVALID', 'TEST_RELEASE_SHA_INVALID',
  'TEST_RELEASE_STS_REQUIRED', 'TEST_RELEASE_TIMEOUT_INVALID', 'TEST_RELEASE_ACTION_DENIED', 'TEST_RELEASE_CLOUD_RESPONSE_INVALID',
  'TEST_RELEASE_RESULT_MISMATCH', 'TEST_RELEASE_OUTPUT_TRUNCATED', 'TEST_RELEASE_OUTPUT_INVALID', 'TEST_RELEASE_TIMEOUT',
  'TEST_RELEASE_SUBMISSION_UNKNOWN', 'TEST_RELEASE_POLL_FAILED', 'TEST_RELEASE_FAILED']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core');

export class CloudReleaseError extends Error {
  constructor(code) {
    const safe = ERROR_CODES.has(code) ? code : 'TEST_RELEASE_FAILED';
    super(safe); this.name = 'CloudReleaseError'; this.code = safe;
  }
}
const fail = code => { throw new CloudReleaseError(code); };

export function readCloudReleaseConfig(env = process.env) {
  if (env.TEST_RELEASE_REGION_ID !== TARGET.regionId || env.TEST_RELEASE_INSTANCE_ID !== TARGET.instanceId) fail('TEST_RELEASE_TARGET_DENIED');
  if (typeof env.TEST_RELEASE_COMMAND_ID !== 'string' || !/^c-[A-Za-z0-9]{5,80}$/.test(env.TEST_RELEASE_COMMAND_ID)) fail('TEST_RELEASE_COMMAND_INVALID');
  if (typeof env.TEST_RELEASE_SHA !== 'string' || !/^[a-f0-9]{40}$/.test(env.TEST_RELEASE_SHA)) fail('TEST_RELEASE_SHA_INVALID');
  const accessKeyId = env.ALIBABA_CLOUD_ACCESS_KEY_ID, accessKeySecret = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET, securityToken = env.ALIBABA_CLOUD_SECURITY_TOKEN;
  if (typeof accessKeyId !== 'string' || !/^STS\.[A-Za-z0-9._-]{1,240}$/.test(accessKeyId)
    || typeof accessKeySecret !== 'string' || !/^[\x21-\x7e]+$/.test(accessKeySecret)
    || typeof securityToken !== 'string' || !/^[\x21-\x7e]+$/.test(securityToken)) fail('TEST_RELEASE_STS_REQUIRED');
  const budget = (name, minimum, maximum) => {
    const value = Number(env[name] ?? maximum);
    if (!Number.isInteger(value) || value < minimum || value > maximum) fail('TEST_RELEASE_TIMEOUT_INVALID');
    return value;
  };
  return Object.freeze({ ...TARGET, commandId: env.TEST_RELEASE_COMMAND_ID, sha: env.TEST_RELEASE_SHA,
    accessKeyId, accessKeySecret, securityToken,
    totalTimeoutMs: budget('TEST_RELEASE_TOTAL_TIMEOUT_MS', 100, 1200000),
    pollIntervalMs: budget('TEST_RELEASE_POLL_INTERVAL_MS', 10, 5000) });
}

function validate(config) {
  return readCloudReleaseConfig({ TEST_RELEASE_REGION_ID: config?.regionId, TEST_RELEASE_INSTANCE_ID: config?.instanceId,
    TEST_RELEASE_COMMAND_ID: config?.commandId, TEST_RELEASE_SHA: config?.sha,
    ALIBABA_CLOUD_ACCESS_KEY_ID: config?.accessKeyId, ALIBABA_CLOUD_ACCESS_KEY_SECRET: config?.accessKeySecret,
    ALIBABA_CLOUD_SECURITY_TOKEN: config?.securityToken,
    TEST_RELEASE_TOTAL_TIMEOUT_MS: config?.totalTimeoutMs, TEST_RELEASE_POLL_INTERVAL_MS: config?.pollIntervalMs });
}

export function createCloudReleaseClient(config) {
  config = validate(config);
  const client = new OpenApiClient(new $OpenApiUtil.Config({
    accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret, securityToken: config.securityToken,
    type: 'sts', regionId: TARGET.regionId, endpoint: 'ecs.cn-beijing.aliyuncs.com', protocol: 'HTTPS',
    retryOptions: new RetryOptions({ retryable: false }),
  }));
  return async (action, body, timeoutMs) => {
    if (!['InvokeCommand', 'DescribeInvocationResults'].includes(action)) fail('TEST_RELEASE_ACTION_DENIED');
    if (body.RegionId !== TARGET.regionId || body.CommandId !== config.commandId
      || (action === 'InvokeCommand' ? body['InstanceId.1'] : body.InstanceId) !== TARGET.instanceId) fail('TEST_RELEASE_TARGET_DENIED');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('TEST_RELEASE_TIMEOUT_INVALID');
    const response = await client.callApi(new $OpenApiUtil.Params({
      action, version: '2014-05-26', protocol: 'HTTPS', pathname: '/', method: 'POST',
      authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
    }), new $OpenApiUtil.OpenApiRequest({ body }), new RuntimeOptions({
      connectTimeout: Math.min(2000, timeoutMs), readTimeout: timeoutMs,
      autoretry: false, maxAttempts: 1, ignoreSSL: false,
    }));
    if (!object(response?.body) || (response.statusCode !== undefined && response.statusCode !== 200)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
    return response.body;
  };
}

function execution(response, config, invokeId) {
  const invocation = response?.Invocation;
  const items = invocation?.InvocationResults?.InvocationResult;
  if (!object(invocation) || !Array.isArray(items) || items.length > 1 || invocation.NextToken
    || (invocation.TotalCount !== undefined && invocation.TotalCount > 1)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
  if (!items.length) return undefined; // Cloud Assistant results can appear after submission.
  const item = items[0];
  if (!object(item) || item.InstanceId !== TARGET.instanceId || item.CommandId !== config.commandId || item.InvokeId !== invokeId) fail('TEST_RELEASE_RESULT_MISMATCH');
  if (!['Pending', 'Running', 'Stopping', 'Success', 'Failed', 'Stopped', 'Invalid', 'Aborted', 'Timeout', 'Error', 'Cancelled'].includes(item.InvocationStatus)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
  return item;
}

function completion(item, config) {
  if (item.Dropped !== 0) fail('TEST_RELEASE_OUTPUT_TRUNCATED');
  if (typeof item.Output !== 'string' || Buffer.byteLength(item.Output) > 4096) fail('TEST_RELEASE_OUTPUT_INVALID');
  let result;
  try { result = JSON.parse(item.Output); } catch { fail('TEST_RELEASE_OUTPUT_INVALID'); }
  if (!object(result) || Object.keys(result).sort().join(',') !== 'code,sha,stage,status,version'
    || result.version !== 1 || result.sha !== config.sha || !STAGES.includes(result.stage)
    || !['passed', 'failed'].includes(result.status) || !['OK', 'FAILED'].includes(result.code)) fail('TEST_RELEASE_OUTPUT_INVALID');
  const passed = item.InvocationStatus === 'Success' && item.ExitCode === 0 && !item.ErrorCode
    && result.stage === 'complete' && result.status === 'passed' && result.code === 'OK';
  return { status: passed ? 'passed' : 'failed', stage: result.stage, code: passed ? 'TEST_RELEASE_OK' : 'TEST_RELEASE_REMOTE_FAILED' };
}

export async function runCloudRelease(config, { call, wait = delay, now = () => performance.now() } = {}) {
  const started = now();
  let stage = 'configuration', requestCount = 0;
  const report = result => ({ ...result, requestCount, durationMs: Math.max(0, Math.round(now() - started)) });
  try {
    config = validate(config);
    call ??= createCloudReleaseClient(config);
    const remaining = () => config.totalTimeoutMs - (now() - started);
    const request = async (action, body) => {
      if (remaining() <= 0) fail('TEST_RELEASE_TIMEOUT');
      const timeoutMs = Math.min(10000, Math.max(1, Math.floor(remaining())));
      requestCount++;
      let timer;
      try {
        const response = await Promise.race([
          Promise.resolve().then(() => call(action, { RegionId: TARGET.regionId, ...body }, timeoutMs)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new CloudReleaseError('TEST_RELEASE_TIMEOUT')), timeoutMs); }),
        ]);
        if (remaining() <= 0) fail('TEST_RELEASE_TIMEOUT');
        return response;
      } finally { clearTimeout(timer); }
    };
    stage = 'submit';
    let submitted;
    try {
      submitted = await request('InvokeCommand', { CommandId: config.commandId, 'InstanceId.1': TARGET.instanceId,
        Parameters: JSON.stringify({ sha: config.sha }), RepeatMode: 'Once', ClientToken: randomUUID() });
    } catch { fail('TEST_RELEASE_SUBMISSION_UNKNOWN'); }
    if (!object(submitted) || typeof submitted.InvokeId !== 'string' || !/^t-[A-Za-z0-9]{5,80}$/.test(submitted.InvokeId)) fail('TEST_RELEASE_CLOUD_RESPONSE_INVALID');
    stage = 'poll';
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      let response;
      try {
        response = await request('DescribeInvocationResults', { CommandId: config.commandId, InvokeId: submitted.InvokeId,
          InstanceId: TARGET.instanceId, ContentEncoding: 'PlainText', MaxResults: 1 });
      } catch (error) {
        if (error instanceof CloudReleaseError && error.code === 'TEST_RELEASE_TIMEOUT') throw error;
        fail('TEST_RELEASE_POLL_FAILED');
      }
      const item = execution(response, config, submitted.InvokeId);
      if (item && !['Pending', 'Running', 'Stopping'].includes(item.InvocationStatus)) return report(completion(item, config));
      if (remaining() <= 0 || attempt === MAX_POLLS - 1) fail('TEST_RELEASE_TIMEOUT');
      await wait(Math.min(config.pollIntervalMs, remaining()));
    }
    fail('TEST_RELEASE_TIMEOUT');
  } catch (error) {
    return report({ status: 'failed', stage, code: error instanceof CloudReleaseError ? error.code : 'TEST_RELEASE_FAILED' });
  }
}

async function main() {
  let result;
  try { result = await runCloudRelease(readCloudReleaseConfig()); }
  catch (error) { result = { status: 'failed', stage: 'configuration', code: error instanceof CloudReleaseError ? error.code : 'TEST_RELEASE_FAILED', requestCount: 0, durationMs: 0 }; }
  let exitCode = result.status === 'passed' ? 0 : 1;
  try {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      'Test server release: **' + result.status + '**\n\nStage: ' + result.stage + '\n\nCode: ' + result.code + '\n');
  } catch {
    result = { status: 'failed', stage: 'report', code: 'TEST_RELEASE_REPORT_FAILED', requestCount: result.requestCount, durationMs: result.durationMs };
    exitCode = 1;
  }
  // Fixed fields only. No provider errors, command output or credentials are printed.
  // On an ambiguous timeout the remote command may still run; never resubmit here.
  // Explicit exit also closes an SDK request that outlived the local deadline.
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(exitCode));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
