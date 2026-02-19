/**
 * TelemetryBus — typed event emitter with snapshot state.
 * Owns all runtime telemetry: connection state, tools, tool calls, errors.
 * Renderers (TUI, LogRenderer) subscribe to events and read snapshot.
 */

import { EventEmitter } from 'events';

// ── Types ──────────────────────────────────────────────────────────

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface ToolCallEntry {
  callId: string;
  tool: string;
  server: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  ok?: boolean;
  preview?: string;
}

interface TelemetryEvents {
  connection_state: { state: ConnectionState; at: number };
  reconnecting: { attempt: number; at: number };
  tools_loaded: { tools: Array<{ name: string; server: string }>; at: number };
  tool_call_start: { callId: string; tool: string; server: string; at: number };
  tool_call_end: { callId: string; tool: string; ok: boolean; durationMs: number; preview: string; at: number };
  setup_step: { key: string; status: 'ok' | 'error' | 'pending'; detail: string; at: number };
  error: { message: string; server?: string; at: number };
  reload_state: { reloading: boolean; at: number };
  tick: { at: number };
  cleared: { at: number };
}

export interface SnapshotView {
  connectionState: ConnectionState;
  connectedAt: number | null;
  tools: Array<{ name: string; server: string }>;
  setupSteps: Array<[string, { status: 'ok' | 'error' | 'pending'; detail: string; at: number }]>;
  recentCalls: ToolCallEntry[];
  recentErrors: Array<{ at: number; message: string; server?: string }>;
  inFlightCalls: Array<[string, { tool: string; server: string; startedAt: number }]>;
  reloading: boolean;
}

// ── RingBuffer ─────────────────────────────────────────────────────

export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(private cap: number) {
    if (cap < 1) throw new RangeError(`RingBuffer capacity must be >= 1, got ${cap}`);
    this.buf = new Array(cap);
  }

  push(item: T): void {
    const idx = (this.head + this.count) % this.cap;
    this.buf[idx] = item;
    if (this.count < this.cap) this.count++;
    else this.head = (this.head + 1) % this.cap;
  }

  toArray(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buf[(this.head + i) % this.cap] as T);
    }
    return result;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buf = new Array(this.cap);
  }
}

// ── Crash-safe redaction ───────────────────────────────────────────

function safeStringify(obj: unknown, maxLen = 200): string {
  if (obj === null || obj === undefined) return String(obj);
  if (typeof obj === 'string') return obj.slice(0, maxLen);
  if (typeof obj !== 'object') return String(obj).slice(0, maxLen);

  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[circular]';
        seen.add(value);
      }
      if (typeof key === 'string' &&
          /password|secret|token|apiKey|authorization|credential/i.test(key)) {
        return '[REDACTED]';
      }
      return value;
    }).slice(0, maxLen);
  } catch {
    return '[unserializable]';
  }
}

export function redact(input: unknown): string {
  const str = safeStringify(input);
  return str
    .replace(/dak_[A-Za-z0-9]{8,}/g, 'dak_[REDACTED]')
    .replace(/sk-[A-Za-z0-9]{8,}/g, 'sk-[REDACTED]')
    .replace(/Bearer\s+[^\s"]{8,}/gi, 'Bearer [REDACTED]');
}

// ── TelemetryBus ───────────────────────────────────────────────────

export class TelemetryBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);  // U2: telemetry bus has many subscribers
  }

  private _snapshot = {
    connectionState: 'disconnected' as ConnectionState,
    connectedAt: null as number | null,
    tools: [] as Array<{ name: string; server: string }>,
    setupSteps: new Map<string, { status: 'ok' | 'error' | 'pending'; detail: string; at: number }>(),
    recentCalls: new RingBuffer<ToolCallEntry>(50),
    recentErrors: new RingBuffer<{ at: number; message: string; server?: string }>(20),
    inFlightCalls: new Map<string, { tool: string; server: string; startedAt: number }>(),
    reloading: false,
  };

  // Tick timers (process lifecycle)
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickUpgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private tickEpoch = 0;

  // ── Subscribe / unsubscribe (public, type-safe) ──

  on<K extends keyof TelemetryEvents>(
    event: K,
    listener: (data: TelemetryEvents[K]) => void,
  ): this {
    this.emitter.on(event, listener);
    return this;
  }

  off<K extends keyof TelemetryEvents>(
    event: K,
    listener: (data: TelemetryEvents[K]) => void,
  ): this {
    this.emitter.off(event, listener);
    return this;
  }

  /**
   * Subscribe a single listener to all state-change events.
   * Returns unsubscribe function.
   * Note: 'tick' excluded — TUI has its own 500ms timer, LogRenderer subscribes explicitly.
   */
  subscribeAll(listener: () => void): () => void {
    const events: (keyof TelemetryEvents)[] = [
      'connection_state', 'reconnecting', 'tools_loaded',
      'tool_call_start', 'tool_call_end', 'setup_step',
      'error', 'reload_state', 'cleared',
    ];
    for (const ev of events) this.emitter.on(ev, listener);
    return () => {
      for (const ev of events) this.emitter.off(ev, listener);
    };
  }

  // ── Emit (protected — only called from methods below) ──

  protected emit<K extends keyof TelemetryEvents>(event: K, data: TelemetryEvents[K]): void {
    this.emitter.emit(event, data);
  }

  // ── Snapshot view (new plain object every call) ──

  getSnapshotView(): SnapshotView {
    return {
      connectionState: this._snapshot.connectionState,
      connectedAt: this._snapshot.connectedAt,
      tools: [...this._snapshot.tools],
      setupSteps: [...this._snapshot.setupSteps.entries()],
      recentCalls: this._snapshot.recentCalls.toArray(),
      recentErrors: this._snapshot.recentErrors.toArray(),
      inFlightCalls: [...this._snapshot.inFlightCalls.entries()],
      reloading: this._snapshot.reloading,
    };
  }

  // ── Hot path getters ──

  get inFlightSize(): number { return this._snapshot.inFlightCalls.size; }
  get isReloading(): boolean { return this._snapshot.reloading; }
  get connectionState(): ConnectionState { return this._snapshot.connectionState; }

  // ── Mutation methods (update snapshot → emit) ──

  setConnectionState(state: ConnectionState): void {
    this._snapshot.connectionState = state;
    if (state === 'connected') this._snapshot.connectedAt = Date.now();
    if (state === 'disconnected') this._snapshot.connectedAt = null;
    this.emit('connection_state', { state, at: Date.now() });
  }

  setReconnecting(attempt: number): void {
    this._snapshot.connectionState = 'reconnecting';
    this.emit('reconnecting', { attempt, at: Date.now() });
  }

  setTools(tools: Array<{ name: string; server: string }>): void {
    this._snapshot.tools = tools;
    this.emit('tools_loaded', { tools, at: Date.now() });
  }

  setSetupStep(key: string, status: 'ok' | 'error' | 'pending', detail: string): void {
    this._snapshot.setupSteps.set(key, { status, detail, at: Date.now() });
    this.emit('setup_step', { key, status, detail, at: Date.now() });
  }

  pushError(message: string, server?: string): void {
    this._snapshot.recentErrors.push({ at: Date.now(), message, server });
    this.emit('error', { message, server, at: Date.now() });
  }

  emitToolStart(callId: string, tool: string, server: string): void {
    const now = Date.now();
    this._snapshot.inFlightCalls.set(callId, { tool, server, startedAt: now });
    this.emit('tool_call_start', { callId, tool, server, at: now });
  }

  emitToolEnd(callId: string, content: unknown, isError: boolean): void {
    const now = Date.now();
    const inflight = this._snapshot.inFlightCalls.get(callId);
    if (!inflight) return;
    const durationMs = now - inflight.startedAt;
    const preview = redact(content);
    this._snapshot.inFlightCalls.delete(callId);

    this._snapshot.recentCalls.push({
      callId,
      tool: inflight.tool,
      server: inflight.server,
      startedAt: inflight.startedAt,
      endedAt: now,
      durationMs,
      ok: !isError,
      preview,
    });

    this.emit('tool_call_end', {
      callId,
      tool: inflight.tool,
      ok: !isError,
      durationMs,
      preview,
      at: now,
    });
  }

  clearRecent(): void {
    this._snapshot.recentCalls.clear();
    this._snapshot.recentErrors.clear();
    this.emit('cleared', { at: Date.now() });
  }

  setReloading(v: boolean): void {
    this._snapshot.reloading = v;
    this.emit('reload_state', { reloading: v, at: Date.now() });
  }

  // ── Tick timer (process lifecycle with epoch guard) ──

  /** Start process tick at 60s interval. Called once at process start. */
  startProcessTick(): void {
    this.stopTick();
    ++this.tickEpoch;
    this.tickTimer = setInterval(() => this.emit('tick', { at: Date.now() }), 60_000);
  }

  /** Schedule slowdown to 300s after 5min stable connected. Called on connect. */
  scheduleSlowTick(): void {
    if (this.tickUpgradeTimer) clearTimeout(this.tickUpgradeTimer);
    const epoch = this.tickEpoch;
    this.tickUpgradeTimer = setTimeout(() => {
      if (this.tickEpoch === epoch && this._snapshot.connectionState === 'connected') {
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.tickTimer = setInterval(() => this.emit('tick', { at: Date.now() }), 300_000);
      }
    }, 300_000);
  }

  /** Reset to fast 60s tick. Called on disconnect/reconnecting. */
  resetToFastTick(): void {
    if (this.tickUpgradeTimer) {
      clearTimeout(this.tickUpgradeTimer);
      this.tickUpgradeTimer = null;
    }
    this.startProcessTick();
  }

  /** Stop all tick timers. Called on shutdown. */
  stopTick(): void {
    if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
    if (this.tickUpgradeTimer) { clearTimeout(this.tickUpgradeTimer); this.tickUpgradeTimer = null; }
  }

  /** U3: Full cleanup — stop timers, remove all listeners, clear buffers. */
  destroy(): void {
    this.stopTick();
    this.emitter.removeAllListeners();
    this._snapshot.recentCalls.clear();
    this._snapshot.recentErrors.clear();
    this._snapshot.setupSteps.clear();
    this._snapshot.inFlightCalls.clear();
  }
}
