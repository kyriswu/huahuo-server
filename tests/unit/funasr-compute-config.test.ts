import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFunAsrCompute, loadFunAsrComputeConfig } from '../../src/integrations/funasr-compute/index.js';
import { FixedFunAsrCompute } from '../../src/integrations/funasr-compute/fixed.js';
import { checkFunAsrReady } from '../../src/integrations/funasr-compute/health.js';

const acsEnvironment = {
  FUNASR_COMPUTE_PROVIDER: 'acs',
  FUNASR_COMPUTE_KUBE_API_URL: 'https://kube.example.test:6443',
  FUNASR_COMPUTE_KUBE_CA_FILE: '/run/kube/ca.crt',
  FUNASR_COMPUTE_KUBE_TOKEN_FILE: '/run/kube/token',
  FUNASR_COMPUTE_NAMESPACE: 'funasr',
  FUNASR_COMPUTE_API_SECRET_NAME: 'funasr-api',
  FUNASR_COMPUTE_IMAGE_PULL_SECRET_NAME: 'funasr-registry',
  FUNASR_COMPUTE_POD_CIDRS: '172.16.0.0/16, 10.2.0.0/24',
};

afterEach(() => vi.unstubAllGlobals());

describe('FunASR compute configuration', () => {
  it('defaults to disabled without requiring Kubernetes credentials', () => {
    expect(loadFunAsrComputeConfig({})).toEqual({ provider: 'disabled' });
    expect(createFunAsrCompute(loadFunAsrComputeConfig({}))).toBeNull();
  });

  it('configures the fixed endpoint without Kubernetes credentials', () => {
    expect(loadFunAsrComputeConfig({
      FUNASR_COMPUTE_PROVIDER: 'fixed',
      FUNASR_COMPUTE_FIXED_BASE_URL: 'http://funasr.internal:8000/',
    })).toEqual({ provider: 'fixed', baseUrl: 'http://funasr.internal:8000' });
  });

  it('uses a pinned image and eight default GPU and zone combinations', () => {
    const config = loadFunAsrComputeConfig(acsEnvironment);
    expect(config).toMatchObject({
      provider: 'acs',
      connection: { apiUrl: 'https://kube.example.test:6443', caFile: '/run/kube/ca.crt', tokenFile: '/run/kube/token' },
      options: {
        namespace: 'funasr',
        image: expect.stringMatching(/@sha256:cbdfcf5ec862a4857d9852a22ba7fa805292170a060cbefde6c4a837443f9d2c$/),
        podCidrs: ['172.16.0.0/16', '10.2.0.0/24'],
        candidates: [
          { model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open' },
          { model: 'G49E', zone: 'cn-beijing-l', driver: '580.95.05-open' },
          { model: 'L20', zone: 'cn-beijing-l', driver: '580.95.05-open' },
          { model: 'L20N', zone: 'cn-beijing-i', driver: '580.95.05-open' },
          { model: 'G59', zone: 'cn-beijing-l', driver: '580.95.05-open' },
          { model: 'L20NE', zone: 'cn-beijing-l', driver: '580.126.09-open' },
          { model: 'G28Ti', zone: 'cn-beijing-h', driver: '580.95.05-open' },
          { model: 'G28Ti', zone: 'cn-beijing-i', driver: '580.95.05-open' },
        ],
      },
    });
  });

  it('accepts certificate paths and validates configured candidate identities', () => {
    expect(loadFunAsrComputeConfig({
      ...acsEnvironment,
      FUNASR_COMPUTE_KUBE_TOKEN_FILE: undefined,
      FUNASR_COMPUTE_KUBE_CLIENT_CERTIFICATE_FILE: '/run/kube/client.crt',
      FUNASR_COMPUTE_KUBE_CLIENT_KEY_FILE: '/run/kube/client.key',
      FUNASR_COMPUTE_CANDIDATES_JSON: JSON.stringify([{ model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open' }]),
    })).toMatchObject({
      connection: { clientCertificateFile: '/run/kube/client.crt', clientKeyFile: '/run/kube/client.key' },
      options: { candidates: [{ model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open' }] },
    });
  });

  it('allows more than one host size for the same GPU and zone', () => {
    const candidates = [
      { model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open' },
      { model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open', resources: { cpu: 8, memoryGiB: 32 } },
    ];
    const config = loadFunAsrComputeConfig({
      ...acsEnvironment,
      FUNASR_COMPUTE_CANDIDATES_JSON: JSON.stringify(candidates),
    });

    expect(config).toMatchObject({ provider: 'acs', options: { candidates } });
  });

  it('treats omitted and explicit default host sizes as the same placement', () => {
    const candidate = { model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open' };
    expect(() => loadFunAsrComputeConfig({
      ...acsEnvironment,
      FUNASR_COMPUTE_CANDIDATES_JSON: JSON.stringify([
        candidate, { ...candidate, resources: { cpu: 4, memoryGiB: 15 } },
      ]),
    })).toThrow('INVALID_CONFIG:FUNASR_COMPUTE_CANDIDATES_JSON');
  });

  it.each([
    { cpu: 8 },
    { cpu: 0, memoryGiB: 32 },
    { cpu: 8, memoryGiB: 15.5 },
    { cpu: 8, memoryGiB: 32, gpu: 2 },
  ])('rejects incomplete or invalid candidate host resources %j', resources => {
    expect(() => loadFunAsrComputeConfig({
      ...acsEnvironment,
      FUNASR_COMPUTE_CANDIDATES_JSON: JSON.stringify([
        { model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open', resources },
      ]),
    })).toThrow('INVALID_CONFIG:FUNASR_COMPUTE_CANDIDATES_JSON');
  });

  it.each([
    ['FUNASR_COMPUTE_POD_CIDRS', '0.0.0.0/0'],
    ['FUNASR_COMPUTE_POD_CIDRS', '169.254.169.254/32'],
    ['FUNASR_COMPUTE_KUBE_API_URL', 'http://kube.example.test:6443'],
    ['FUNASR_COMPUTE_KUBE_API_URL', 'https://user:secret@kube.example.test/'],
    ['FUNASR_COMPUTE_IMAGE', 'registry.example.test/team/funasr:latest'],
    ['FUNASR_COMPUTE_CANDIDATES_JSON', '[]'],
    ['FUNASR_COMPUTE_CANDIDATES_JSON', '[{"model":"a/b","zone":"cn-beijing-i","driver":"580.95.05-open"}]'],
    ['FUNASR_COMPUTE_LIFETIME_SECONDS', '600'],
  ])('rejects invalid %s without reporting the supplied value', (key, value) => {
    expect(() => loadFunAsrComputeConfig({ ...acsEnvironment, [key]: value })).toThrow(
      new Error('INVALID_CONFIG:' + key),
    );
  });
});

describe('FunASR compute readiness', () => {
  it('only probes readiness and never follows redirects', async () => {
    const fetch = vi.fn(async () => Response.json({ status: 'ready', device: 'cuda:0' }));
    vi.stubGlobal('fetch', fetch);
    const compute = new FixedFunAsrCompute('http://funasr.internal:8000');
    await compute.start('recording-test');
    await expect(compute.status('recording-test')).resolves.toEqual({
      state: 'ready', baseUrl: 'http://funasr.internal:8000',
    });
    await expect(compute.release('recording-test')).resolves.toBe('released');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(new URL('http://funasr.internal:8000/readyz'), expect.objectContaining({
      method: 'GET', redirect: 'error',
    }));
  });

  it.each([
    () => Response.json({ status: 'ready', device: 'cpu' }),
    () => Response.json({ status: 'ready', device: 'cuda:0' }, { status: 503 }),
    () => new Response('x'.repeat(70 * 1024)),
  ])('rejects incompatible or oversized readiness responses', async response => {
    vi.stubGlobal('fetch', vi.fn(async () => response()));
    await expect(checkFunAsrReady('http://funasr.internal:8000')).resolves.toBe(false);
  });

  it('propagates a caller abort', async () => {
    const signal = AbortSignal.abort(new Error('cancelled'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(checkFunAsrReady('http://funasr.internal:8000', signal)).rejects.toThrow('cancelled');
    expect(fetch).not.toHaveBeenCalled();
  });
});
