import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RetryOptions, RuntimeOptions } from '@darabonba/typescript';

const REGION = 'cn-beijing';
const TOTAL_TIMEOUT_MS = 87 * 60_000;
const POLL_INTERVAL_MS = 5_000;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core');

class VerificationError extends Error {}
const fail = code => { throw new VerificationError(code); };

function readConfig(env) {
  const instanceId = env.TEST_ACK_BUILDER_INSTANCE_ID;
  const commandId = env.TEST_ACK_RELEASE_COMMAND_ID;
  const sha = env.TEST_RELEASE_SHA;
  if (instanceId !== 'i-2zeaydxol26pp3dxg1ak' || !/^c-[A-Za-z0-9]{5,80}$/.test(commandId ?? '')) fail('TEST_ACK_TARGET_INVALID');
  if (!SHA.test(sha ?? '')) fail('TEST_ACK_SHA_INVALID');

  const accessKeyId = env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const accessKeySecret = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const securityToken = env.ALIBABA_CLOUD_SECURITY_TOKEN;
  if (!/^STS\.[A-Za-z0-9._-]{1,240}$/.test(accessKeyId ?? '') || !/^[\x21-\x7e]+$/.test(accessKeySecret ?? '')
    || !/^[\x21-\x7e]+$/.test(securityToken ?? '')) fail('TEST_ACK_STS_REQUIRED');
  return { instanceId, commandId, sha, accessKeyId, accessKeySecret, securityToken };
}

function createEcsClient({ accessKeyId, accessKeySecret, securityToken }) {
  const client = new OpenApiClient(new $OpenApiUtil.Config({
    accessKeyId, accessKeySecret, securityToken, type: 'sts', regionId: REGION,
    endpoint: 'ecs.cn-beijing.aliyuncs.com', protocol: 'HTTPS', retryOptions: new RetryOptions({ retryable: false }),
  }));
  return async (action, body, timeoutMs) => {
    const response = await client.callApi(new $OpenApiUtil.Params({
      action, version: '2014-05-26', protocol: 'HTTPS', pathname: '/', method: 'POST',
      authType: 'AK', style: 'RPC', reqBodyType: 'formData', bodyType: 'json',
    }), new $OpenApiUtil.OpenApiRequest({ body }), new RuntimeOptions({
      connectTimeout: Math.min(2_000, timeoutMs), readTimeout: timeoutMs,
      autoretry: false, maxAttempts: 1, ignoreSSL: false,
    }));
    if (response?.statusCode !== undefined && response.statusCode !== 200) fail('TEST_ACK_CLOUD_RESPONSE_INVALID');
    return response?.body;
  };
}

function readInvocation(response, { instanceId, commandId }, invokeId) {
  const invocation = response?.Invocation;
  const rows = invocation?.InvocationResults?.InvocationResult;
  if (!Array.isArray(rows) || rows.length > 1 || invocation.NextToken ||
    (invocation.TotalCount !== undefined && invocation.TotalCount > 1)) fail('TEST_ACK_CLOUD_RESPONSE_INVALID');
  if (rows.length === 0) return undefined;
  const item = rows[0];
  if (item?.InstanceId !== instanceId || item.CommandId !== commandId || item.InvokeId !== invokeId) fail('TEST_ACK_RESULT_MISMATCH');
  return item;
}

function readSuccess(item, sha) {
  if (item.InvocationStatus !== 'Success' || item.ExitCode !== 0 || item.ErrorCode) fail('TEST_ACK_REMOTE_FAILED');
  const output = item.Output;
  if ((item.Dropped !== undefined && item.Dropped !== 0) || typeof output !== 'string'
    || Buffer.byteLength(output) > 4096) fail('TEST_ACK_OUTPUT_INVALID');
  let marker;
  try { marker = JSON.parse(output); } catch { fail('TEST_ACK_OUTPUT_INVALID'); }
  if (!marker || typeof marker !== 'object' || Object.keys(marker).sort().join(',') !== 'digest,sha,status,version'
    || marker.version !== 1 || marker.sha !== sha || marker.status !== 'deployed'
    || typeof marker.digest !== 'string' || !DIGEST.test(marker.digest)) fail('TEST_ACK_OUTPUT_INVALID');
  return { sha, digest: marker.digest };
}

export async function releaseAckImage(env = process.env, { call, now = () => performance.now(), wait = delay } = {}) {
  const config = readConfig(env);
  call ??= createEcsClient(config);
  const deadline = now() + TOTAL_TIMEOUT_MS;
  const remaining = () => deadline - now();
  const request = async (action, body) => {
    if (remaining() <= 0) fail('TEST_ACK_TIMEOUT');
    const timeoutMs = Math.max(1, Math.min(10_000, Math.floor(remaining())));
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => call(action, { RegionId: REGION, ...body }, timeoutMs)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new VerificationError('TEST_ACK_TIMEOUT')), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  };

  let submitted;
  try {
    submitted = await request('InvokeCommand', { CommandId: config.commandId, 'InstanceId.1': config.instanceId,
      Parameters: JSON.stringify({ sha: config.sha }), RepeatMode: 'Once', ClientToken: randomUUID() });
  } catch { fail('TEST_ACK_SUBMISSION_UNKNOWN'); }
  const invokeId = submitted?.InvokeId;
  if (typeof invokeId !== 'string' || !/^t-[A-Za-z0-9]{5,80}$/.test(invokeId)) fail('TEST_ACK_SUBMISSION_UNKNOWN');

  for (let attempt = 0; attempt < TOTAL_TIMEOUT_MS / POLL_INTERVAL_MS && remaining() > 0; attempt++) {
    let response;
    try {
      response = await request('DescribeInvocationResults', { CommandId: config.commandId, InvokeId: invokeId,
        InstanceId: config.instanceId, ContentEncoding: 'PlainText', MaxResults: 1 });
    } catch (error) {
      if (error instanceof VerificationError && error.message === 'TEST_ACK_TIMEOUT') throw error;
      fail('TEST_ACK_POLL_FAILED');
    }
    if (remaining() <= 0) break;
    const item = readInvocation(response, config, invokeId);
    if (item && !['Pending', 'Running', 'Stopping'].includes(item.InvocationStatus)) return readSuccess(item, config.sha);
    if (remaining() > 0) await wait(Math.min(POLL_INTERVAL_MS, remaining()));
  }
  fail('TEST_ACK_TIMEOUT');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { sha, digest } = await releaseAckImage();
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `## Test ACK deployment passed\n\n- Test SHA: \`${sha}\`\n- Image digest: \`${digest}\`\n`);
    console.log(JSON.stringify({ status: 'deployed', sha, digest }));
  } catch (error) {
    const code = error instanceof VerificationError ? error.message : 'TEST_ACK_VERIFICATION_FAILED';
    console.error(`::error::${code}`);
    process.exitCode = 1;
  }
}
