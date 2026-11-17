import type { Redis } from 'ioredis';
import type { IdleAction } from './index.js';
import type { MachineState } from './redis.js';

export interface MonitorEvents { onAction?: (action: IdleAction) => void; onError?: (error: unknown) => void }
interface WatchedMachine { state: { status(): Promise<MachineState | undefined> }; tick(): Promise<IdleAction> }
type Subscriber = Pick<Redis, 'connect' | 'subscribe' | 'on' | 'off' | 'disconnect'>;
const fallbackMs = 60_000;

/** Event-driven idle deadline, with a temporary one-minute watchdog until a stable end state. */
export class ParserMachineIdleMonitor {
  private idleTimer?: NodeJS.Timeout;
  private fallbackTimer?: NodeJS.Timeout;
  private idleActivity?: number;
  private startTask?: Promise<void>;
  private refreshTask?: Promise<void>;
  private checkTask?: Promise<void>;
  private resubscribeTask?: Promise<void>;
  private subscriptionInstalled = false;
  private dirty = false;
  private connected = false;
  private stopped = false;
  private checking = false;
  private retryAfter = 0;
  constructor(private readonly machine: WatchedMachine, private readonly subscriber: Subscriber, private readonly channel: string,
    private readonly idleMs: number, private readonly events: MonitorEvents = {}) {}

  private readonly changed = (channel: string) => { if (channel === this.channel) void this.refresh(); };
  private readonly ready = () => {
    if (this.stopped || !this.subscriptionInstalled) return;
    this.disconnected();
    // Wait for SUBSCRIBE acknowledgement BEFORE reading state, closing the reconnect event gap.
    this.resubscribeTask = (async () => {
      await this.subscriber.subscribe(this.channel);
      if (!this.stopped) { this.connected = true; await this.refresh(); }
    })().catch(error => { if (!this.stopped) this.events.onError?.(error); });
  };
  private readonly disconnected = () => { this.connected = false; this.clearTimers(); };
  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('DOCUMENT_PARSER_MONITOR_CLOSED'));
    return this.startTask ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    this.subscriber.on('message', this.changed);
    this.subscriber.on('ready', this.ready);
    this.subscriber.on('close', this.disconnected);
    this.subscriber.on('error', this.disconnected);
    try {
      await this.subscriber.connect();
      if (this.stopped) return;
      await this.subscriber.subscribe(this.channel);
      if (this.stopped) return;
    } catch { this.stop(); throw new Error('DOCUMENT_PARSER_SUBSCRIPTION_FAILED'); }
    this.subscriptionInstalled = true; this.connected = true; await this.refresh();
  }
  private clearIdle() { if (this.idleTimer) clearTimeout(this.idleTimer); this.idleTimer = undefined; this.idleActivity = undefined; }
  private clearTimers() { this.clearIdle(); if (this.fallbackTimer) clearTimeout(this.fallbackTimer); this.fallbackTimer = undefined; }
  private fallback() {
    if (this.stopped || !this.connected || this.fallbackTimer) return;
    this.fallbackTimer = setTimeout(() => { this.fallbackTimer = undefined; this.check(); }, fallbackMs);
    this.fallbackTimer.unref();
  }
  private plan(state: MachineState | undefined) {
    if (this.stopped || !this.connected || this.checking) return;
    // No perpetual timer after verified stop, before first use, or while human reconciliation is required.
    if (!state || state.phase === 'blocked' || state.uncertain > 0 || (state.economicallyStopped && state.active === 0 && state.queued === 0)) {
      this.clearTimers(); return;
    }
    if (state.phase !== 'ready' || state.active > 0 || state.queued > 0) { this.clearIdle(); this.fallback(); return; }
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer); this.fallbackTimer = undefined;
    if (this.idleTimer && this.idleActivity === state.lastActivityMs) return;
    this.clearIdle(); this.idleActivity = state.lastActivityMs;
    const delay = Math.max(0, this.idleMs - (state.redisTimeMs - state.lastActivityMs), this.retryAfter - Date.now());
    this.idleTimer = setTimeout(() => { this.idleTimer = undefined; this.check(); }, delay);
    this.idleTimer.unref();
  }
  private refresh(): Promise<void> {
    this.dirty = true;
    this.refreshTask ??= (async () => {
      while (this.dirty && !this.stopped && this.connected) {
        this.dirty = false; this.plan(await this.machine.state.status());
      }
    })().catch(error => { this.clearTimers(); this.events.onError?.(error); this.fallback(); }).finally(() => {
      this.refreshTask = undefined;
      if (this.dirty && !this.stopped && this.connected) void this.refresh();
    });
    return this.refreshTask;
  }
  private check() {
    if (this.stopped || !this.connected || this.checking) return;
    this.checking = true; this.clearTimers();
    this.checkTask = (async () => {
      const state = await this.machine.state.status();
      if (this.stopped || !this.connected) return;
      if (!state || state.phase === 'blocked' || state.uncertain > 0 || (state.economicallyStopped && !state.active && !state.queued)) return;
      // Busy work only needs Redis lease reconciliation; no cloud status poll is necessary.
      if (state.phase === 'ready' && (state.active > 0 || state.queued > 0 || state.redisTimeMs - state.lastActivityMs < this.idleMs)) return;
      const action = await this.machine.tick();
      this.events.onAction?.(action);
    })().catch(error => { this.retryAfter = Date.now() + fallbackMs; this.events.onError?.(error); }).finally(async () => {
      this.checking = false; await this.refresh();
    });
  }
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true; this.connected = false; this.subscriptionInstalled = false; this.dirty = false; this.clearTimers();
    this.subscriber.off('message', this.changed); this.subscriber.off('ready', this.ready);
    this.subscriber.off('close', this.disconnected); this.subscriber.off('error', this.disconnected);
    this.subscriber.disconnect();
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.all([this.startTask?.catch(() => undefined), this.checkTask, this.refreshTask, this.resubscribeTask]);
  }
}
