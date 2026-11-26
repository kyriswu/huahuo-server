import { describe, expect, it, vi } from 'vitest';
import { AcsFunAsrCompute } from '../../src/integrations/funasr-compute/acs.js';
import { loadFunAsrComputeConfig } from '../../src/integrations/funasr-compute/config.js';
import { KubernetesApiError, type KubernetesRequest, type KubernetesTransport } from '../../src/integrations/funasr-compute/kubernetes.js';
import type { AcsFunAsrOptions } from '../../src/integrations/funasr-compute/types.js';

const options: AcsFunAsrOptions = {
  namespace: 'asr',
  image: 'registry.example/funasr@sha256:' + 'a'.repeat(64),
  apiSecretName: 'funasr-api',
  imagePullSecretName: 'funasr-acr',
  podCidrs: ['172.31.128.0/20'],
  candidates: [
    { model: 'A10', zone: 'cn-beijing-i', driver: '580.95.05-open' },
    { model: 'L20', zone: 'cn-beijing-l', driver: '580.95.05-open' },
  ],
  batchSize: 3,
  startupTimeoutSeconds: 600,
  lifetimeSeconds: 3600,
};

function defaultAcsOptions(): AcsFunAsrOptions {
  const config = loadFunAsrComputeConfig({
    FUNASR_COMPUTE_PROVIDER: 'acs',
    FUNASR_COMPUTE_KUBE_API_URL: 'https://kube.example.test:6443',
    FUNASR_COMPUTE_KUBE_CA_FILE: '/run/kube/ca.crt',
    FUNASR_COMPUTE_KUBE_TOKEN_FILE: '/run/kube/token',
    FUNASR_COMPUTE_NAMESPACE: options.namespace,
    FUNASR_COMPUTE_API_SECRET_NAME: options.apiSecretName,
    FUNASR_COMPUTE_IMAGE_PULL_SECRET_NAME: options.imagePullSecretName,
    FUNASR_COMPUTE_POD_CIDRS: options.podCidrs.join(','),
    FUNASR_COMPUTE_IMAGE: options.image,
  });
  if (config.provider !== 'acs') throw new Error('Expected ACS configuration');
  return config.options;
}

type Resource = {
  metadata: { name: string; uid?: string; resourceVersion?: string; ownerReferences?: Array<{ uid: string }> };
  spec?: { template: { metadata: { labels: Record<string, string> } } };
  status?: { conditions: Array<{ type: string; status: string }> };
};

class FakeCluster {
  readonly resources = new Map<string, Resource>();
  readonly writes: KubernetesRequest[] = [];
  readonly pods: unknown[] = [];
  deferJobs?: Promise<void>;
  loseCreateReply = false;
  rejectJobSlots: number[] = [];
  private revision = 0;

  request = async (request: KubernetesRequest): Promise<unknown> => {
    const path = request.path.split('?')[0]!;
    if (request.method === 'GET') {
      if (path.endsWith('/pods')) return { items: this.pods };
      if (path.endsWith('/jobs')) {
        return { items: [...this.resources].filter(([key]) => key.startsWith(path + '/')).map(([, value]) => value) };
      }
      const found = this.resources.get(path);
      if (!found) throw new KubernetesApiError(404);
      return found;
    }
    this.writes.push(request);
    if (request.method === 'DELETE') {
      const found = this.resources.get(path);
      if (!found) throw new KubernetesApiError(404);
      const body = request.body as { preconditions: { uid: string }; propagationPolicy: string };
      expect(body.preconditions.uid).toBe(found.metadata.uid);
      expect(body.propagationPolicy).toBe('Foreground');
      this.resources.delete(path);
      return {};
    }
    const object = structuredClone(request.body) as Resource;
    const key = request.method === 'POST' ? path + '/' + object.metadata.name : path;
    const existing = this.resources.get(key);
    if (request.method === 'POST') {
      if (path.endsWith('/jobs')) {
        await this.deferJobs;
        if (this.rejectJobSlots.some(slot => object.metadata.name.endsWith('-' + slot))) {
          throw new KubernetesApiError(422);
        }
      }
      if (this.resources.has(key)) throw new KubernetesApiError(409);
    } else if (!existing || existing.metadata.resourceVersion !== object.metadata.resourceVersion) {
      throw new KubernetesApiError(existing ? 409 : 404);
    }
    const version = String(++this.revision);
    object.metadata = { ...object.metadata, uid: existing?.metadata.uid ?? 'uid-' + version, resourceVersion: version };
    this.resources.set(key, object);
    if (path.endsWith('/jobs') && this.loseCreateReply) {
      this.loseCreateReply = false;
      throw new KubernetesApiError();
    }
    return object;
  };

  jobs() {
    return [...this.resources].filter(([name]) => name.includes('/jobs/')).map(([, resource]) => resource);
  }

  jobSubmissions() {
    return this.writes.filter(request => request.method === 'POST' && request.path.endsWith('/jobs'));
  }

  failJobs() {
    for (const job of this.jobs()) job.status = { conditions: [{ type: 'Failed', status: 'True' }] };
  }

  pod(job: Resource, ip: string, ready = true) {
    return {
      metadata: { name: job.metadata.name + '-pod', uid: job.metadata.uid + '-pod',
        labels: job.spec!.template.metadata.labels,
        ownerReferences: [{ uid: job.metadata.uid, kind: 'Job', controller: true }] },
      status: { phase: 'Running', podIP: ip, conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
    };
  }
}

function afterNextBatchClaim(cluster: FakeCluster, afterClaim: () => void): KubernetesTransport {
  return async request => {
    const response = await cluster.request(request);
    const data = (request.body as { data?: Record<string, string> } | undefined)?.data;
    if (request.method === 'PUT' && data?.phase === 'submitting' && data.batchOffset === '3') afterClaim();
    return response;
  };
}

describe('ACS FunASR compute', () => {
  it('starts the first three of eight default candidates in parallel under one durable allocation', async () => {
    const config = defaultAcsOptions();
    expect(config.candidates).toHaveLength(8);
    const cluster = new FakeCluster();
    let openGate!: () => void;
    cluster.deferJobs = new Promise<void>(resolve => { openGate = resolve; });
    const compute = new AcsFunAsrCompute(config, cluster.request);
    const starting = compute.start('asr:activation:1');
    try {
      await vi.waitFor(() => expect(cluster.jobSubmissions()).toHaveLength(3));

      await new AcsFunAsrCompute(config, cluster.request).start('asr:activation:1');
      expect(await compute.status('asr:activation:1')).toEqual({ state: 'starting' });
    } finally {
      openGate();
      await starting;
    }
    expect(cluster.jobs()).toHaveLength(3);
    expect(cluster.jobs().map(job => job.spec?.template.metadata.labels['alibabacloud.com/compute-qos'])).toEqual([
      'default', 'best-effort', 'default',
    ]);
    for (const job of cluster.jobs()) {
      expect(job).toMatchObject({
        metadata: { ownerReferences: [{ kind: 'ConfigMap', uid: expect.any(String) }] },
        spec: { activeDeadlineSeconds: 3600, ttlSecondsAfterFinished: 60, backoffLimit: 0, podReplacementPolicy: 'Failed',
          template: { spec: { restartPolicy: 'Never', automountServiceAccountToken: false,
            imagePullSecrets: [{ name: 'funasr-acr' }],
            containers: [{ image: options.image, resources: {
              requests: { cpu: '4', memory: '15Gi', 'nvidia.com/gpu': '1' },
              limits: { cpu: '4', memory: '15Gi', 'nvidia.com/gpu': '1' },
            } }],
          } },
        },
      });
    }
  });

  it('drains a timed-out batch before concurrent observers can launch the next three and final two candidates', async () => {
    const config = defaultAcsOptions();
    const cluster = new FakeCluster();
    const allocationId = 'staged-asr';
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const unready = async () => false;
    try {
      await new AcsFunAsrCompute(config, cluster.request, unready).start(allocationId);
      expect(cluster.jobSubmissions()).toHaveLength(3);
      const first = cluster.jobs()[0]!;
      cluster.pods.push(cluster.pod(first, '172.31.140.1', false));
      clock.mockReturnValue(now + config.startupTimeoutSeconds * 1000 + 1);

      const restarted = new AcsFunAsrCompute(config, cluster.request, unready);
      await vi.waitFor(async () => {
        expect(await restarted.status(allocationId)).toEqual({ state: 'starting' });
        expect(cluster.jobs()).toHaveLength(0);
      });
      expect(await restarted.status(allocationId)).toEqual({ state: 'starting' });
      expect(cluster.jobSubmissions()).toHaveLength(3);

      cluster.pods.length = 0;
      const concurrent = new AcsFunAsrCompute(config, cluster.request, unready);
      await vi.waitFor(async () => {
        await Promise.all([restarted.status(allocationId), concurrent.status(allocationId)]);
        expect(cluster.jobSubmissions()).toHaveLength(6);
      });
      expect(cluster.jobs()).toHaveLength(3);
      expect(cluster.jobs().map(job => job.spec?.template.metadata.labels['alibabacloud.com/compute-qos'])).toEqual([
        'best-effort', 'default', 'default',
      ]);
      expect(await restarted.status(allocationId)).toEqual({ state: 'starting' });

      cluster.failJobs();
      await vi.waitFor(async () => {
        await Promise.all([restarted.status(allocationId), concurrent.status(allocationId)]);
        expect(cluster.jobSubmissions()).toHaveLength(8);
      });
      expect(cluster.jobs()).toHaveLength(2);

      cluster.failJobs();
      await vi.waitFor(async () => {
        expect(await concurrent.status(allocationId)).toEqual({ state: 'failed' });
        expect(cluster.jobs()).toHaveLength(0);
      });
      expect(cluster.jobSubmissions()).toHaveLength(8);
    } finally { clock.mockRestore(); }
  });

  it('resumes implicit standard QoS allocations with explicit default and fences a changed QoS', async () => {
    const cluster = new FakeCluster();
    const id = 'allocation-with-legacy-qos';
    await new AcsFunAsrCompute(options, cluster.request).start(id);

    const candidates = options.candidates.map(candidate => ({ ...candidate, qos: 'default' as const }));
    await expect(new AcsFunAsrCompute({ ...options, candidates }, cluster.request).start(id)).resolves.toBeUndefined();
    const revised = new AcsFunAsrCompute({
      ...options, candidates: [{ ...candidates[0]!, qos: 'best-effort' }, candidates[1]!],
    }, cluster.request);
    await expect(revised.start(id)).rejects.toThrow('FUNASR_COMPUTE_CONFIGURATION_CHANGED');
    await expect(revised.release(id)).resolves.toBe('releasing');
    await expect(revised.release(id)).resolves.toBe('released');
  });

  it('injects callback configuration into each candidate and binds it to the allocation', async () => {
    const cluster = new FakeCluster();
    const callbackOptions = { ...options, callbackOrigin: 'https://server.internal:8443' };
    const compute = new AcsFunAsrCompute(callbackOptions, cluster.request);
    const allocationId = 'callback-configured';

    await compute.start(allocationId);
    expect(cluster.jobs()).toHaveLength(2);
    for (const job of cluster.jobs()) {
      expect(job).toMatchObject({ spec: { template: { spec: { containers: [{ env: [
        { name: 'DEVICE', value: 'cuda:0' },
        { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: 'funasr-api', key: 'API_TOKEN' } } },
        { name: 'CALLBACK_ALLOWED_ORIGINS', value: 'https://server.internal:8443' },
        { name: 'CALLBACK_SECRET', valueFrom: { secretKeyRef: { name: 'funasr-api', key: 'CALLBACK_SECRET' } } },
      ] }] } } } });
    }
    const restarted = new AcsFunAsrCompute(callbackOptions, cluster.request);
    await expect(restarted.start(allocationId)).resolves.toBeUndefined();
    const moved = new AcsFunAsrCompute({ ...callbackOptions, callbackOrigin: 'https://new.internal' }, cluster.request);
    await expect(moved.start(allocationId)).rejects.toThrow('FUNASR_COMPUTE_CONFIGURATION_CHANGED');
    await expect(moved.release(allocationId)).resolves.toBe('releasing');
    await expect(moved.release(allocationId)).resolves.toBe('released');
  });

  it('keeps a healthy first-batch winner even after its startup timeout and does not launch later candidates', async () => {
    const config = defaultAcsOptions();
    const cluster = new FakeCluster();
    const allocationId = 'initial-batch-winner';
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const ready = async () => true;
    try {
      const compute = new AcsFunAsrCompute(config, cluster.request, ready);
      await compute.start(allocationId);
      cluster.pods.push(cluster.pod(cluster.jobs()[0]!, '172.31.140.1'));
      const winner = { state: 'ready', baseUrl: 'http://172.31.140.1:8000' };
      await vi.waitFor(async () => expect(await compute.status(allocationId)).toEqual(winner));
      clock.mockReturnValue(now + config.startupTimeoutSeconds * 1000 + 1);
      const restarted = new AcsFunAsrCompute(config, cluster.request, ready);
      expect(await restarted.status(allocationId)).toEqual(winner);
      expect(cluster.jobs()).toHaveLength(1);
      expect(cluster.jobSubmissions()).toHaveLength(3);
    } finally { clock.mockRestore(); }
  });

  it('recovers a committed batch claim with a lost response and submits the next candidates once', async () => {
    const config = defaultAcsOptions();
    const cluster = new FakeCluster();
    const lostResponse = vi.fn(() => { throw new KubernetesApiError(); });
    const request = afterNextBatchClaim(cluster, lostResponse);
    const first = new AcsFunAsrCompute(config, request);
    const second = new AcsFunAsrCompute(config, request);
    const id = 'lost-next-batch-claim';
    await first.start(id);
    cluster.failJobs();
    await first.status(id);

    await Promise.all([first.status(id), second.status(id)]);

    expect(lostResponse).toHaveBeenCalledTimes(1);
    expect(cluster.jobSubmissions()).toHaveLength(6);
    expect(cluster.jobs()).toHaveLength(3);
    expect(await second.status(id)).toEqual({ state: 'starting' });
  });

  it('finishes the claimed batch when the observer aborts without cancelling the allocation', async () => {
    const config = defaultAcsOptions();
    const cluster = new FakeCluster();
    const controller = new AbortController();
    const abort = new Error('observation expired');
    const request = afterNextBatchClaim(cluster, () => controller.abort(abort));
    const observer = new AcsFunAsrCompute(config, request);
    const id = 'abort-next-batch-observer';
    await observer.start(id);
    cluster.failJobs();
    await observer.status(id);

    await expect(observer.status(id, controller.signal)).rejects.toBe(abort);

    const resumed = new AcsFunAsrCompute(config, cluster.request);
    expect(await resumed.status(id)).toEqual({ state: 'starting' });
    expect(cluster.jobSubmissions()).toHaveLength(6);
    expect(cluster.jobs()).toHaveLength(3);
  });

  it('requests the configured larger host size for a candidate without increasing its GPU count', async () => {
    const cluster = new FakeCluster();
    const compute = new AcsFunAsrCompute({ ...options, candidates: [
      options.candidates[0]!,
      { ...options.candidates[1]!, resources: { cpu: 8, memoryGiB: 32 } },
    ] }, cluster.request);
    await compute.start('larger-host');

    expect(cluster.jobs()).toMatchObject([
      { spec: { template: { spec: { containers: [{ resources: {
        requests: { cpu: '4', memory: '15Gi', 'nvidia.com/gpu': '1' },
        limits: { cpu: '4', memory: '15Gi', 'nvidia.com/gpu': '1' },
      } }] } } } },
      { spec: { template: { spec: { containers: [{ resources: {
        requests: { cpu: '8', memory: '32Gi', 'nvidia.com/gpu': '1' },
        limits: { cpu: '8', memory: '32Gi', 'nvidia.com/gpu': '1' },
      } }] } } } },
    ]);
  });

  it('resumes a legacy allocation with explicit defaults but fences a changed host size', async () => {
    const cluster = new FakeCluster();
    await new AcsFunAsrCompute(options, cluster.request).start('existing-allocation');
    const explicitDefaults = new AcsFunAsrCompute({ ...options, candidates: options.candidates.map(candidate => ({
      ...candidate, resources: { cpu: 4, memoryGiB: 15 },
    })) }, cluster.request);
    const largerHosts = new AcsFunAsrCompute({ ...options, candidates: options.candidates.map(candidate => ({
      ...candidate, resources: { cpu: 8, memoryGiB: 32 },
    })) }, cluster.request);

    await expect(explicitDefaults.start('existing-allocation')).resolves.toBeUndefined();
    await expect(largerHosts.start('existing-allocation')).rejects.toThrow('FUNASR_COMPUTE_CONFIGURATION_CHANGED');
    await expect(largerHosts.release('existing-allocation')).resolves.toBe('releasing');
    await expect(largerHosts.release('existing-allocation')).resolves.toBe('released');
  });

  it('keeps the healthy winner across adapter restarts and waits for loser Pods to disappear', async () => {
    const cluster = new FakeCluster();
    cluster.loseCreateReply = true;
    const ready = vi.fn(async (url: string) => url.endsWith('.2:8000'));
    const compute = new AcsFunAsrCompute(options, cluster.request, ready);
    await compute.start('shared-asr');
    const [first, second] = cluster.jobs();
    cluster.pods.push(cluster.pod(first!, '172.31.140.1'), cluster.pod(second!, '172.31.140.2'));

    expect(await compute.status('shared-asr')).toEqual({ state: 'starting' });
    expect(ready).toHaveBeenCalledWith('http://172.31.140.2:8000', expect.any(AbortSignal));
    expect(cluster.jobs().map(job => job.metadata.uid)).toEqual([second!.metadata.uid]);
    cluster.pods.shift();
    const recovered = new AcsFunAsrCompute(options, cluster.request, ready);
    expect(await recovered.status('shared-asr')).toEqual({ state: 'ready', baseUrl: 'http://172.31.140.2:8000' });
    await recovered.start('shared-asr');
    expect(cluster.jobs()).toHaveLength(1);

    expect(await recovered.release('shared-asr')).toBe('releasing');
    expect(await recovered.status('shared-asr')).toEqual({ state: 'releasing' });
    cluster.pods.length = 0;
    expect(await recovered.status('shared-asr')).toEqual({ state: 'missing' });
    expect(await recovered.release('shared-asr')).toBe('released');
  });

  it('does not probe a deceptive, unready or out-of-range Pod', async () => {
    const cluster = new FakeCluster();
    const ready = vi.fn(async () => true);
    const compute = new AcsFunAsrCompute(options, cluster.request, ready);
    await compute.start('untrusted-status');
    const [first, second] = cluster.jobs();
    const foreign = cluster.pod(first!, '172.31.140.3');
    foreign.metadata.ownerReferences[0]!.uid = 'other-job';
    cluster.pods.push(foreign, cluster.pod(first!, '169.254.169.254'), cluster.pod(second!, '172.31.140.4', false));
    expect(await compute.status('untrusted-status')).toEqual({ state: 'starting' });
    expect(ready).not.toHaveBeenCalled();
  });

  it('can use a healthy candidate after another is rejected at admission', async () => {
    const cluster = new FakeCluster();
    cluster.rejectJobSlots = [0];
    const compute = new AcsFunAsrCompute(options, cluster.request, async () => true);
    await compute.start('admission-fallback');
    expect(cluster.jobs()).toHaveLength(1);
    cluster.pods.push(cluster.pod(cluster.jobs()[0]!, '172.31.140.4'));
    expect(await compute.status('admission-fallback')).toEqual({ state: 'ready', baseUrl: 'http://172.31.140.4:8000' });
  });

  it('keeps the allocation record until in-flight Job creation can be cleaned up', async () => {
    const cluster = new FakeCluster();
    let openGate!: () => void;
    cluster.deferJobs = new Promise<void>(resolve => { openGate = resolve; });
    const first = new AcsFunAsrCompute(options, cluster.request);
    const second = new AcsFunAsrCompute(options, cluster.request);
    const starting = first.start('cancel-in-flight');
    await vi.waitFor(() => expect(cluster.writes.filter(request => request.path.endsWith('/jobs'))).toHaveLength(2));

    await second.release('cancel-in-flight');
    expect(await second.status('cancel-in-flight')).toEqual({ state: 'releasing' });
    openGate();
    await starting;
    expect(await second.status('cancel-in-flight')).toEqual({ state: 'missing' });
    expect(cluster.resources.size).toBe(0);
  });

  it('elects one winner when two workers observe different healthy candidates at once', async () => {
    const cluster = new FakeCluster();
    const first = new AcsFunAsrCompute(options, cluster.request, async url => url.includes('.1:'));
    const second = new AcsFunAsrCompute(options, cluster.request, async url => url.includes('.2:'));
    await first.start('concurrent-readiness');
    const jobs = cluster.jobs();
    cluster.pods.push(cluster.pod(jobs[0]!, '172.31.140.1'), cluster.pod(jobs[1]!, '172.31.140.2'));

    await Promise.all([first.status('concurrent-readiness'), second.status('concurrent-readiness')]);
    expect(cluster.jobs()).toHaveLength(1);
    const winner = cluster.jobs()[0]!;
    const url = winner === jobs[0] ? 'http://172.31.140.1:8000' : 'http://172.31.140.2:8000';
    cluster.pods.splice(0, cluster.pods.length, cluster.pod(winner, new URL(url).hostname));
    expect(await new AcsFunAsrCompute(options, cluster.request, async () => true).status('concurrent-readiness'))
      .toEqual({ state: 'ready', baseUrl: url });
  });
});
