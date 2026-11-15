import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
// @ts-expect-error Release tooling deliberately uses plain JavaScript.
import { CloudReleaseError, createCloudReleaseClient, readCloudReleaseConfig, runCloudRelease } from '../../scripts/release/invoke-cloud-release.mjs';

const { default: OpenApiClient } = createRequire(import.meta.url)('@alicloud/openapi-core') as typeof import('@alicloud/openapi-core');
const instanceId = 'i-2zegtoygiiked53yntmj', commandId = 'c-reviewedCommand123', invokeId = 't-fixtureInvocation123';
const sha = '0123456789abcdef0123456789abcdef01234567';
const accessKeyId = 'STS.release-fixture-only', accessKeySecret = 'private-cloud-secret-fixture', securityToken = 'private-cloud-security-token-fixture';
const privateOutput = 'private-remote-output-must-not-be-logged';
const env = () => ({
  TEST_RELEASE_REGION_ID: 'cn-beijing', TEST_RELEASE_INSTANCE_ID: instanceId, TEST_RELEASE_COMMAND_ID: commandId,
  TEST_RELEASE_SHA: sha, ALIBABA_CLOUD_ACCESS_KEY_ID: accessKeyId,
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: accessKeySecret, ALIBABA_CLOUD_SECURITY_TOKEN: securityToken,
});
const marker = () => ({ version: 1, sha, stage: 'complete', status: 'passed', code: 'OK' });
const record = (change: Record<string, unknown> = {}) => ({
  InstanceId: instanceId, InvokeId: invokeId, CommandId: commandId, InvocationStatus: 'Success',
  ExitCode: 0, Dropped: 0, Output: JSON.stringify(marker()), ...change,
});
const response = (items: unknown[] = [record()]) => ({ Invocation: { InvocationResults: { InvocationResult: items } } });
type Call = (action: string, body: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
function setup(result: unknown = response(), variables: Record<string, string> = {}) {
  let time = 0;
  const call = vi.fn<Call>(async action => action === 'InvokeCommand' ? { InvokeId: invokeId } : result);
  return { config: readCloudReleaseConfig({ ...env(), TEST_RELEASE_TOTAL_TIMEOUT_MS: '100', TEST_RELEASE_POLL_INTERVAL_MS: '10', ...variables }),
    call, now: () => time, wait: vi.fn(async (milliseconds: number) => { time += milliseconds; }) };
}
function expectSanitized(value: unknown) {
  const output = JSON.stringify(value);
  for (const secret of [accessKeyId, accessKeySecret, securityToken, privateOutput]) expect(output).not.toContain(secret);
  expect(output.length).toBeLessThan(4096);
}
function cli(variables: Record<string, string>) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/release/invoke-cloud-release.mjs'], {
      cwd: process.cwd(), env: { PATH: process.env.PATH, ...variables }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk));
    child.once('error', reject); child.once('close', code => resolve({ code, output: Buffer.concat(chunks).toString() }));
  });
}
afterEach(() => vi.restoreAllMocks());

describe('reviewed cloud release command with local RPC fixtures only', () => {
  it('invokes the one fixed instance once with only the commit parameter and verifies the exact invocation', async () => {
    const s = setup();
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('passed'); expectSanitized(result);
    expect(s.call).toHaveBeenCalledTimes(2);
    const [action, body, timeout] = s.call.mock.calls[0]!;
    expect(action).toBe('InvokeCommand');
    expect(body).toEqual({ RegionId: 'cn-beijing', 'InstanceId.1': instanceId, CommandId: commandId,
      Parameters: JSON.stringify({ sha }), RepeatMode: 'Once', ClientToken: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    expect(timeout).toBeGreaterThan(0); expect(timeout).toBeLessThanOrEqual(10000);
    expect(s.call.mock.calls[1]?.slice(0, 2)).toEqual(['DescribeInvocationResults', {
      RegionId: 'cn-beijing', InstanceId: instanceId, InvokeId: invokeId, CommandId: commandId,
      ContentEncoding: 'PlainText', MaxResults: 1,
    }]);
  });

  it('polls a running invocation without resubmitting the command', async () => {
    const s = setup();
    s.call.mockResolvedValueOnce({ InvokeId: invokeId })
      .mockResolvedValueOnce(response([record({ InvocationStatus: 'Running', Output: privateOutput })]))
      .mockResolvedValueOnce(response());
    expect((await runCloudRelease(s.config, s)).status).toBe('passed');
    expect(s.call.mock.calls.map(args => args[0])).toEqual(['InvokeCommand', 'DescribeInvocationResults', 'DescribeInvocationResults']);
    expect(s.wait).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['different instance', { InstanceId: 'i-not-the-authorized-instance' }],
    ['different invocation', { InvokeId: 't-anotherInvocation' }],
    ['different reviewed command', { CommandId: 'c-anotherCommand' }],
    ['nonzero exit', { ExitCode: 1 }], ['string exit', { ExitCode: '0' }],
    ['truncated output', { Dropped: 1 }], ['missing truncation field', { Dropped: undefined }],
    ['failed invocation', { InvocationStatus: 'Failed' }], ['stopped invocation', { InvocationStatus: 'Stopped' }],
    ['unknown invocation status', { InvocationStatus: 'NotARealStatus' }],
    ['unstructured output', { Output: privateOutput }], ['missing terminal marker', { Output: '{}' }],
    ['wrong commit', { Output: JSON.stringify({ ...marker(), sha: 'f'.repeat(40) }) }],
    ['unfinished release', { Output: JSON.stringify({ ...marker(), stage: 'deploy' }) }],
    ['failed release', { Output: JSON.stringify({ ...marker(), status: 'failed' }) }],
    ['unknown marker version', { Output: JSON.stringify({ ...marker(), version: 2 }) }],
    ['unknown marker fields', { Output: JSON.stringify({ ...marker(), raw: privateOutput }) }],
    ['success text mixed with raw output', { Output: privateOutput + '\n' + JSON.stringify(marker()) }],
  ])('rejects %s even when the provider call succeeds', async (_name, change) => {
    const s = setup(response([record(change)]));
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expect(result.code).toMatch(/^[A-Z][A-Z0-9_]+$/); expectSanitized(result);
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
  });

  it.each([
    ['multiple invocation records', response([record(), record()])],
    ['malformed invocation collection', { Invocation: { InvocationResults: { InvocationResult: {} } } }],
    ['missing invocation envelope', { Output: JSON.stringify(marker()) }],
  ])('rejects %s', async (_name, body) => {
    const s = setup(body);
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result);
  });

  it('stops polling at the total deadline without a second invocation or cancellation', async () => {
    const s = setup(response([record({ InvocationStatus: 'Running', Output: privateOutput })]));
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result);
    expect(s.now()).toBeGreaterThanOrEqual(100); expect(s.now()).toBeLessThanOrEqual(110);
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
    expect(s.call.mock.calls.every(args => ['InvokeCommand', 'DescribeInvocationResults'].includes(args[0]))).toBe(true);
    expect(s.call.mock.calls.length).toBeLessThanOrEqual(12);
  });

  it('also caps polling requests when a shortened interval leaves a large time budget', async () => {
    const s = setup(response([]), { TEST_RELEASE_TOTAL_TIMEOUT_MS: '1200000' });
    const result = await runCloudRelease(s.config, s);
    expect(result).toMatchObject({ status: 'failed', code: 'TEST_RELEASE_TIMEOUT', requestCount: 241 });
    expect(s.call.mock.calls.filter(args => args[0] === 'InvokeCommand')).toHaveLength(1);
    expect(s.call.mock.calls.filter(args => args[0] === 'DescribeInvocationResults')).toHaveLength(240);
  });

  it.each(['invoke', 'poll'])('bounds a hung %s transport even when the SDK never resolves', async stage => {
    const s = setup();
    if (stage === 'poll') s.call.mockResolvedValueOnce({ InvokeId: invokeId });
    s.call.mockImplementationOnce(() => new Promise(() => undefined));
    const started = Date.now();
    const result = await runCloudRelease(s.config, { call: s.call });
    expect(result).toMatchObject({ status: 'failed', code: stage === 'invoke' ? 'TEST_RELEASE_SUBMISSION_UNKNOWN' : 'TEST_RELEASE_TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000); expectSanitized(result);
    expect(s.call).toHaveBeenCalledTimes(stage === 'invoke' ? 1 : 2);
  });

  it.each(['invoke', 'poll'])('sanitizes an ambiguous %s failure and never retries the write', async stage => {
    const s = setup();
    const failure = new Error([privateOutput, accessKeyId, accessKeySecret, securityToken].join(' '));
    if (stage === 'poll') s.call.mockResolvedValueOnce({ InvokeId: invokeId });
    s.call.mockRejectedValueOnce(failure);
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result);
    expect(s.call).toHaveBeenCalledTimes(stage === 'poll' ? 2 : 1);
  });

  it('rejects an invocation response without an ID instead of guessing or resubmitting', async () => {
    const s = setup(); s.call.mockResolvedValueOnce({ RequestId: privateOutput });
    const result = await runCloudRelease(s.config, s);
    expect(result.status).toBe('failed'); expectSanitized(result); expect(s.call).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['TEST_RELEASE_REGION_ID', 'cn-hangzhou'], ['TEST_RELEASE_INSTANCE_ID', 'i-unapproved'],
    ['TEST_RELEASE_COMMAND_ID', ''], ['TEST_RELEASE_COMMAND_ID', 'c-x'], ['TEST_RELEASE_COMMAND_ID', 'c-invalid;command'],
    ['TEST_RELEASE_SHA', 'main'], ['TEST_RELEASE_SHA', 'A'.repeat(40)], ['TEST_RELEASE_SHA', sha + '\nrm'],
    ['ALIBABA_CLOUD_ACCESS_KEY_ID', 'LTAI-long-lived-key'], ['ALIBABA_CLOUD_ACCESS_KEY_SECRET', ''], ['ALIBABA_CLOUD_SECURITY_TOKEN', ''],
    ['TEST_RELEASE_TOTAL_TIMEOUT_MS', '99'], ['TEST_RELEASE_TOTAL_TIMEOUT_MS', '1200001'],
    ['TEST_RELEASE_POLL_INTERVAL_MS', '9'], ['TEST_RELEASE_POLL_INTERVAL_MS', '5001'],
  ])('rejects unsafe configuration %s before an RPC', (key, value) => {
    expect(() => readCloudReleaseConfig({ ...env(), [key]: value })).toThrow(CloudReleaseError);
  });

  it('uses the real SDK over HTTPS POST, temporary credentials, a fixed endpoint, and disabled retries', async () => {
    const rpc = vi.spyOn(OpenApiClient.prototype, 'callApi').mockResolvedValue({ body: { InvokeId: invokeId } });
    const config = readCloudReleaseConfig(env());
    const call = createCloudReleaseClient(config);
    const body = { RegionId: 'cn-beijing', 'InstanceId.1': instanceId, CommandId: commandId, Parameters: JSON.stringify({ sha }) };
    expect(await call('InvokeCommand', body, 1234)).toEqual({ InvokeId: invokeId });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [params, request, runtime] = rpc.mock.calls[0]!;
    expect(params).toMatchObject({ action: 'InvokeCommand', version: '2014-05-26', protocol: 'HTTPS', method: 'POST', style: 'RPC', reqBodyType: 'formData', bodyType: 'json' });
    expect(request.body).toEqual(body); expect(Object.keys(request.query ?? {})).toHaveLength(0);
    expect(runtime).toMatchObject({ autoretry: false, maxAttempts: 1, ignoreSSL: false });
    expect(runtime.connectTimeout).toBeLessThanOrEqual(1234); expect(runtime.readTimeout).toBeLessThanOrEqual(1234);
    const client = rpc.mock.contexts[0] as InstanceType<typeof OpenApiClient>;
    expect(client._endpoint).toBe('ecs.cn-beijing.aliyuncs.com'); expect(client._retryOptions.retryable).toBe(false);
    expect(await client._credential.getCredential()).toMatchObject({ accessKeyId, accessKeySecret, securityToken });
  });

  it('refuses unrelated cloud actions at the SDK boundary without a transport request', async () => {
    const rpc = vi.spyOn(OpenApiClient.prototype, 'callApi').mockResolvedValue({ body: {} });
    const call = createCloudReleaseClient(readCloudReleaseConfig(env()));
    await expect(call('RunCommand', { RegionId: 'cn-beijing', CommandContent: privateOutput }, 1000)).rejects.toThrow(CloudReleaseError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('CLI rejects missing configuration with nonzero exit and sanitized output before any cloud call', async () => {
    const result = await cli({ ...env(), TEST_RELEASE_COMMAND_ID: '' });
    expect(result.code).not.toBe(0); expect(result.output).toContain('failed'); expectSanitized(result);
  });
});
