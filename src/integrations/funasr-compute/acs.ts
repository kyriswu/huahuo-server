import { createHash, randomUUID } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { checkFunAsrReady } from './health.js';
import { KubernetesApiError, type KubernetesRequest, type KubernetesTransport } from './kubernetes.js';
import { defaultAcsGpuHostResources, FunAsrComputeError, validateAllocationId, type AcsFunAsrOptions, type AcsGpuCandidate,
  type FunAsrCompute, type FunAsrComputeRelease, type FunAsrComputeStatus } from './types.js';

const ownerLabel = 'app.kubernetes.io/managed-by';
const owner = 'huahuo-funasr-compute';
const allocationLabel = 'huahuo.app/funasr-allocation';
const port = 8000;

type JsonObject = Record<string, unknown>;
type Phase = 'submitting' | 'active' | 'selected' | 'failed' | 'releasing';
type Reference = { name: string; uid: string };
type Allocation = Reference & {
  resourceVersion: string;
  phase: Phase;
  attempt: string;
  fingerprint: string;
  startupDeadline: number;
  submissionComplete: boolean;
  candidateCount: number;
  jobUids: string[];
  jobUid?: string;
  podUid?: string;
};
type Job = Reference & { terminal: boolean; deleting: boolean };
type Pod = Reference & { jobUid: string; ready: boolean; terminal: boolean; ip?: string };
type Snapshot = { jobs: Job[]; pods: Pod[] };
type Probe = (url: string, signal?: AbortSignal) => Promise<boolean>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function items(value: unknown): JsonObject[] {
  const { items } = object(value);
  if (!Array.isArray(items)) throw new FunAsrComputeError('FUNASR_COMPUTE_KUBERNETES_RESPONSE_INVALID');
  return items.map(object);
}

function reference(value: unknown): Reference {
  const { name, uid } = object(value);
  if (typeof name !== 'string' || !name || typeof uid !== 'string' || !uid) {
    throw new FunAsrComputeError('FUNASR_COMPUTE_KUBERNETES_RESPONSE_INVALID');
  }
  return { name, uid };
}

function condition(status: JsonObject, ...types: string[]): boolean {
  return Array.isArray(status.conditions) && status.conditions.some(entry => {
    const item = object(entry);
    return typeof item.type === 'string' && types.includes(item.type) && item.status === 'True';
  });
}

function owners(metadata: JsonObject): JsonObject[] {
  return Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences.map(object) : [];
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function allocationName(id: string): string {
  validateAllocationId(id);
  return 'funasr-' + hash(id).slice(0, 32);
}

function labels(name: string) {
  return { [ownerLabel]: owner, [allocationLabel]: name };
}

function belongs(metadata: JsonObject, name: string): boolean {
  const marked = object(metadata.labels);
  return marked[ownerLabel] === owner && marked[allocationLabel] === name;
}

function uncertainCreate(error: unknown): boolean {
  return error instanceof KubernetesApiError
    && (error.status === undefined || error.status >= 500 || [408, 409, 429].includes(error.status));
}

function allocation(value: unknown, name: string): Allocation {
  const { metadata: rawMetadata, data: rawData } = object(value);
  const metadata = object(rawMetadata);
  const ref = reference(metadata);
  const { phase, fingerprint, startupDeadline, attempt, submissionComplete, candidateCount, jobUids, jobUid, podUid } = object(rawData);
  const version = metadata.resourceVersion;
  if (ref.name !== name || !belongs(metadata, name) || typeof version !== 'string'
      || (phase !== 'submitting' && phase !== 'active' && phase !== 'selected' && phase !== 'failed' && phase !== 'releasing')
      || typeof fingerprint !== 'string' || typeof attempt !== 'string' || typeof jobUids !== 'string'
      || (submissionComplete !== 'true' && submissionComplete !== 'false')
      || typeof candidateCount !== 'string' || !/^[1-8]$/u.test(candidateCount)
      || typeof startupDeadline !== 'string' || !Number.isSafeInteger(Number(startupDeadline))) {
    throw new FunAsrComputeError('FUNASR_COMPUTE_ALLOCATION_CONFLICT');
  }
  let uids: unknown;
  try { uids = JSON.parse(jobUids); }
  catch { throw new FunAsrComputeError('FUNASR_COMPUTE_ALLOCATION_CONFLICT'); }
  if (!Array.isArray(uids) || !uids.every(uid => typeof uid === 'string')
      || (phase === 'selected' && (typeof jobUid !== 'string' || typeof podUid !== 'string' || !uids.includes(jobUid)))) {
    throw new FunAsrComputeError('FUNASR_COMPUTE_ALLOCATION_CONFLICT');
  }
  return { ...ref, resourceVersion: version, phase, attempt, fingerprint, startupDeadline: Number(startupDeadline),
    submissionComplete: submissionComplete === 'true', candidateCount: Number(candidateCount),
    jobUids: uids, jobUid: typeof jobUid === 'string' ? jobUid : undefined,
    podUid: typeof podUid === 'string' ? podUid : undefined };
}

export class AcsFunAsrCompute implements FunAsrCompute {
  private readonly options: AcsFunAsrOptions;
  private readonly configMaps: string;
  private readonly jobs: string;
  private readonly pods: string;
  private readonly fingerprint: string;
  private readonly allowed = new BlockList();
  private readonly privateNetwork = new BlockList();

  constructor(options: AcsFunAsrOptions, private readonly request: KubernetesTransport,
    private readonly probe: Probe = checkFunAsrReady) {
    this.options = structuredClone(options);
    const namespace = encodeURIComponent(options.namespace);
    this.configMaps = '/api/v1/namespaces/' + namespace + '/configmaps';
    this.pods = '/api/v1/namespaces/' + namespace + '/pods';
    this.jobs = '/apis/batch/v1/namespaces/' + namespace + '/jobs';
    const candidates = options.candidates.map(candidate => {
      const identity = [candidate.model, candidate.zone, candidate.driver];
      const { cpu, memoryGiB } = candidate.resources ?? defaultAcsGpuHostResources;
      // Keep the fingerprint of allocations created with the original host size.
      if (cpu === defaultAcsGpuHostResources.cpu && memoryGiB === defaultAcsGpuHostResources.memoryGiB) return identity;
      return [...identity, cpu, memoryGiB];
    });
    this.fingerprint = hash(JSON.stringify([options.namespace, options.image, options.apiSecretName,
      options.imagePullSecretName, options.podCidrs, candidates,
      options.startupTimeoutSeconds, options.lifetimeSeconds]));
    this.privateNetwork.addSubnet('10.0.0.0', 8);
    this.privateNetwork.addSubnet('172.16.0.0', 12);
    this.privateNetwork.addSubnet('192.168.0.0', 16);
    this.privateNetwork.addSubnet('fc00::', 7, 'ipv6');
    for (const cidr of options.podCidrs) {
      const [address, prefix] = cidr.split('/');
      this.allowed.addSubnet(address!, Number(prefix), isIP(address!) === 6 ? 'ipv6' : 'ipv4');
    }
  }

  async start(id: string, signal?: AbortSignal): Promise<void> {
    const name = allocationName(id);
    signal?.throwIfAborted();
    const previous = await this.getAllocation(name, signal);
    if (previous) { this.assertConfiguration(previous); return; }
    const attempt = randomUUID();
    const startupDeadline = Date.now() + this.options.startupTimeoutSeconds * 1000;
    const data = { fingerprint: this.fingerprint, attempt, startupDeadline: String(startupDeadline),
      phase: 'submitting', submissionComplete: 'false', candidateCount: String(this.options.candidates.length), jobUids: '[]' };
    let claimed: Allocation;
    try {
      claimed = allocation(await this.request({ method: 'POST', path: this.configMaps,
        body: this.configMap({ name, labels: labels(name) }, data) }), name);
    } catch (error) {
      if (!uncertainCreate(error)) throw error;
      const recovered = await this.getAllocation(name, signal);
      if (!recovered) throw error;
      claimed = recovered;
    }
    this.assertConfiguration(claimed);
    if (claimed.attempt !== attempt || claimed.phase !== 'submitting') return;
    if (signal?.aborted) {
      await this.completeSubmission(claimed, [], true);
      await this.release(id);
      signal.throwIfAborted();
    }

    // Mutation requests have their own timeout. Allow every POST to settle before deciding what can be cleaned.
    const jobs = await Promise.allSettled(this.options.candidates.map((candidate, index) =>
      this.submitJob(claimed, candidate, index)));
    const jobUids = jobs.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value.uid] : []);
    const updated = await this.completeSubmission(claimed, jobUids, jobs.every(result => result.status === 'fulfilled'));
    if (signal?.aborted) {
      await this.release(id);
      signal.throwIfAborted();
    }
    if (updated?.phase === 'failed') await this.clearJobs(await this.snapshot(updated, signal));
    if (updated?.phase === 'releasing') await this.finishRelease(updated, signal);
  }

  async status(id: string, signal?: AbortSignal): Promise<FunAsrComputeStatus> {
    signal?.throwIfAborted();
    const record = await this.getAllocation(allocationName(id), signal);
    if (!record) return { state: 'missing' };
    if (record.phase === 'releasing') return this.finishRelease(record, signal);
    this.assertConfiguration(record);
    if (record.phase === 'submitting' && Date.now() < record.startupDeadline) return { state: 'starting' };
    const current = await this.snapshot(record, signal);
    if (record.phase === 'failed') {
      await this.clearJobs(current);
      return { state: 'failed' };
    }
    if (record.phase === 'selected') return this.selected(record, current, signal);
    if (Date.now() >= record.startupDeadline || current.jobs.every(job => job.terminal)) {
      const failed = await this.update(record, { phase: 'failed' });
      if (!failed) return { state: 'starting' };
      await this.clearJobs(current);
      return { state: 'failed' };
    }
    const winner = await this.firstReady(record, current, signal);
    if (!winner) return { state: 'starting' };
    signal?.throwIfAborted();
    const chosen = await this.update(record, { phase: 'selected', jobUid: winner.jobUid, podUid: winner.uid });
    // An independent observer may have won the resourceVersion race. Its selection is authoritative.
    if (!chosen) return { state: 'starting' };
    return this.selected(chosen, current, signal, true);
  }

  async release(id: string, signal?: AbortSignal): Promise<FunAsrComputeRelease> {
    const name = allocationName(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const current = await this.getAllocation(name, signal);
      if (!current) return 'released';
      const releasing = current.phase === 'releasing' ? current : await this.update(current, { phase: 'releasing' });
      if (releasing) return (await this.finishRelease(releasing, signal)).state === 'missing' ? 'released' : 'releasing';
    }
    throw new FunAsrComputeError('FUNASR_COMPUTE_STATE_CHANGED');
  }

  private assertConfiguration(record: Allocation): void {
    if (record.fingerprint !== this.fingerprint) throw new FunAsrComputeError('FUNASR_COMPUTE_CONFIGURATION_CHANGED');
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown | null> {
    try { return await this.request({ method: 'GET', path, signal }); }
    catch (error) {
      if (error instanceof KubernetesApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async getAllocation(name: string, signal?: AbortSignal): Promise<Allocation | null> {
    const value = await this.get(this.configMaps + '/' + name, signal);
    return value === null ? null : allocation(value, name);
  }

  private configMap(metadata: JsonObject, data: Record<string, string>) {
    return { apiVersion: 'v1', kind: 'ConfigMap', metadata: { namespace: this.options.namespace, ...metadata }, data };
  }

  private async update(record: Allocation,
    change: Partial<Pick<Allocation, 'phase' | 'submissionComplete' | 'jobUids' | 'jobUid' | 'podUid'>>) {
    const next = { ...record, ...change };
    const data = { phase: next.phase, attempt: next.attempt, fingerprint: next.fingerprint,
      startupDeadline: String(next.startupDeadline), submissionComplete: String(next.submissionComplete),
      candidateCount: String(next.candidateCount), jobUids: JSON.stringify(next.jobUids),
      ...(next.jobUid && next.podUid ? { jobUid: next.jobUid, podUid: next.podUid } : {}) };
    const metadata = { name: record.name, uid: record.uid, resourceVersion: record.resourceVersion, labels: labels(record.name) };
    try {
      return allocation(await this.request({ method: 'PUT', path: this.configMaps + '/' + record.name,
        body: this.configMap(metadata, data) }), record.name);
    } catch (error) {
      if (error instanceof KubernetesApiError && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }

  private async completeSubmission(original: Allocation, jobUids: string[], submissionComplete: boolean) {
    let current = original;
    for (let attempt = 0; attempt < 3; attempt++) {
      const phase = current.phase === 'submitting' ? (submissionComplete && jobUids.length ? 'active' : 'failed') : current.phase;
      const updated = await this.update(current, { phase, jobUids, submissionComplete });
      if (updated) return updated;
      const latest = await this.getAllocation(original.name);
      if (latest?.uid !== original.uid) return null;
      current = latest;
    }
    throw new FunAsrComputeError('FUNASR_COMPUTE_STATE_CHANGED');
  }

  private async submitJob(record: Allocation, candidate: AcsGpuCandidate, index: number): Promise<Reference | null> {
    const name = record.name + '-' + index;
    const { cpu, memoryGiB } = candidate.resources ?? defaultAcsGpuHostResources;
    const resources = { cpu: String(cpu), memory: `${memoryGiB}Gi`, 'nvidia.com/gpu': '1' };
    const podLabels = { ...labels(record.name), 'alibabacloud.com/compute-class': 'gpu',
      'alibabacloud.com/compute-qos': 'default', 'alibabacloud.com/gpu-model-series': candidate.model,
      'alibabacloud.com/gpu-driver-version': candidate.driver };
    const body = {
      apiVersion: 'batch/v1', kind: 'Job',
      metadata: { name, namespace: this.options.namespace, labels: labels(record.name),
        ownerReferences: [{ apiVersion: 'v1', kind: 'ConfigMap', name: record.name, uid: record.uid, controller: true }] },
      spec: { parallelism: 1, completions: 1, backoffLimit: 0, podReplacementPolicy: 'Failed',
        activeDeadlineSeconds: this.options.lifetimeSeconds,
        ttlSecondsAfterFinished: 60,
        template: { metadata: { labels: podLabels }, spec: {
          restartPolicy: 'Never', automountServiceAccountToken: false,
          securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
          nodeSelector: { 'kubernetes.io/arch': 'amd64', 'topology.kubernetes.io/zone': candidate.zone },
          imagePullSecrets: [{ name: this.options.imagePullSecretName }],
          containers: [{ name: 'funasr', image: this.options.image,
            securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001,
              allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
            ports: [{ name: 'http', containerPort: port }],
            env: [{ name: 'DEVICE', value: 'cuda:0' },
              { name: 'API_TOKEN', valueFrom: { secretKeyRef: { name: this.options.apiSecretName, key: 'API_TOKEN' } } }],
            resources: { requests: resources, limits: resources },
            readinessProbe: { httpGet: { path: '/readyz', port }, periodSeconds: 5, timeoutSeconds: 3 },
          }],
        } },
      },
    };
    let value: unknown;
    try {
      value = await this.request({ method: 'POST', path: this.jobs, body });
    } catch (error) {
      if (error instanceof KubernetesApiError && !uncertainCreate(error)) return null;
      if (!uncertainCreate(error)) throw error;
      value = await this.get(this.jobs + '/' + name);
      if (!value) throw error;
    }
    const metadata = object(object(value).metadata);
    const job = reference(metadata);
    if (job.name !== name || !belongs(metadata, record.name) || !owners(metadata).some(o => o.kind === 'ConfigMap' && o.uid === record.uid)) {
      throw new FunAsrComputeError('FUNASR_COMPUTE_JOB_OWNERSHIP_INVALID');
    }
    return job;
  }

  private async snapshot(record: Allocation, signal?: AbortSignal): Promise<Snapshot> {
    const labelSelector = '?' + new URLSearchParams({ labelSelector: ownerLabel + '=' + owner + ',' + allocationLabel + '=' + record.name });
    const [jobs, pods] = await Promise.all([
      this.request({ method: 'GET', path: this.jobs + labelSelector, signal }),
      this.request({ method: 'GET', path: this.pods + labelSelector, signal }),
    ]);
    const names = new Set(Array.from({ length: record.candidateCount }, (_, index) => record.name + '-' + index));
    const ownedJobs = items(jobs).flatMap(job => {
      const metadata = object(job.metadata);
      if (!belongs(metadata, record.name) || !owners(metadata).some(o => o.kind === 'ConfigMap' && o.uid === record.uid)) return [];
      if (typeof metadata.name !== 'string' || !names.has(metadata.name)) return [];
      const deleting = Boolean(metadata.deletionTimestamp);
      return [{ ...reference(metadata), deleting, terminal: deleting || condition(object(job.status), 'Complete', 'Failed') }];
    });
    const ownedUids = new Set([...record.jobUids, ...ownedJobs.map(job => job.uid)]);
    const ownedPods = items(pods).flatMap(pod => {
      const metadata = object(pod.metadata);
      const jobUid = owners(metadata).find(o => o.kind === 'Job' && o.controller === true)?.uid;
      if (!belongs(metadata, record.name) || typeof jobUid !== 'string' || !ownedUids.has(jobUid)) return [];
      const status = object(pod.status);
      const terminal = Boolean(metadata.deletionTimestamp) || status.phase === 'Failed' || status.phase === 'Succeeded';
      return [{ ...reference(metadata), jobUid, terminal, ready: !terminal && status.phase === 'Running' && condition(status, 'Ready'),
        ip: typeof status.podIP === 'string' ? status.podIP : undefined }];
    });
    return { jobs: ownedJobs, pods: ownedPods };
  }

  private endpoint(pod: Pod): string | undefined {
    if (!pod.ready || !pod.ip) return;
    const ip = isIP(pod.ip);
    const family = ip === 6 ? 'ipv6' : 'ipv4';
    if (!ip || !this.privateNetwork.check(pod.ip, family) || !this.allowed.check(pod.ip, family)) return;
    return 'http://' + (ip === 6 ? '[' + pod.ip + ']' : pod.ip) + ':' + port;
  }

  private async firstReady(record: Allocation, current: Snapshot, signal?: AbortSignal): Promise<Pod | null> {
    const live = new Set(current.jobs.filter(job => !job.terminal && record.jobUids.includes(job.uid)).map(job => job.uid));
    const stop = new AbortController();
    const probeSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const probes = current.pods.filter(pod => live.has(pod.jobUid)).flatMap(pod => {
      const url = this.endpoint(pod);
      if (!url) return [];
      return [this.probe(url, probeSignal).then(ready => {
        if (!ready) throw new FunAsrComputeError('FUNASR_COMPUTE_NOT_READY');
        return pod;
      })];
    });
    try { return await Promise.any(probes); }
    catch { signal?.throwIfAborted(); return null; }
    finally { stop.abort(); }
  }

  private async selected(record: Allocation, current: Snapshot, signal?: AbortSignal, probed = false): Promise<FunAsrComputeStatus> {
    signal?.throwIfAborted();
    const winner = current.pods.find(pod => pod.uid === record.podUid && pod.jobUid === record.jobUid);
    if (!winner || winner.terminal || !current.jobs.some(job => job.uid === winner.jobUid && !job.terminal)) {
      const failed = await this.update(record, { phase: 'failed' });
      if (!failed) return { state: 'starting' };
      await this.clearJobs(current);
      return { state: 'failed' };
    }
    await this.clearJobs(current, winner.jobUid);
    if (current.jobs.some(job => job.uid !== winner.jobUid) || current.pods.some(pod => pod.uid !== winner.uid)) {
      return { state: 'starting' };
    }
    const url = this.endpoint(winner);
    if (!url || (!probed && !await this.probe(url, signal))) return { state: 'starting' };
    const latest = await this.getAllocation(record.name, signal);
    if (!latest) return { state: 'missing' };
    if (latest.phase !== 'selected' || latest.uid !== record.uid || latest.podUid !== winner.uid) return { state: 'starting' };
    return { state: 'ready', baseUrl: url };
  }

  private async clearJobs(current: Snapshot, keep?: string): Promise<void> {
    await Promise.all(current.jobs.filter(job => job.uid !== keep && !job.deleting)
      .map(job => this.remove(this.jobs, job)));
  }

  private async finishRelease(record: Allocation, signal?: AbortSignal): Promise<FunAsrComputeStatus> {
    const current = await this.snapshot(record, signal);
    await this.clearJobs(current);
    const submissionInFlight = !record.submissionComplete && Date.now() < record.startupDeadline;
    if (submissionInFlight || current.jobs.length || current.pods.length) return { state: 'releasing' };
    await this.remove(this.configMaps, record);
    return await this.getAllocation(record.name, signal) ? { state: 'releasing' } : { state: 'missing' };
  }

  private async remove(collection: string, ref: Reference): Promise<void> {
    const request: KubernetesRequest = { method: 'DELETE', path: collection + '/' + encodeURIComponent(ref.name),
      body: { apiVersion: 'v1', kind: 'DeleteOptions', propagationPolicy: 'Foreground', preconditions: { uid: ref.uid } } };
    try { await this.request(request); }
    catch (error) {
      if (error instanceof KubernetesApiError && error.status === 404) return;
      throw error;
    }
  }
}
