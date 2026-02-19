import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RingBuffer, TelemetryBus, redact } from '../src/telemetry.js';

// ─── RingBuffer ───────────────────────────────────────────────────

describe('RingBuffer', () => {
  it('returns items in insertion order', () => {
    const rb = new RingBuffer<number>(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
  });

  it('overwrites oldest when capacity exceeded', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4); // evicts 1
    rb.push(5); // evicts 2
    expect(rb.toArray()).toEqual([3, 4, 5]);
  });

  it('handles capacity=1 — only holds last item', () => {
    const rb = new RingBuffer<string>(1);
    rb.push('a');
    rb.push('b');
    rb.push('c');
    expect(rb.toArray()).toEqual(['c']);
  });

  it('toArray on empty returns []', () => {
    const rb = new RingBuffer<number>(10);
    expect(rb.toArray()).toEqual([]);
  });

  it('clear resets to empty', () => {
    const rb = new RingBuffer<number>(5);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.clear();
    expect(rb.toArray()).toEqual([]);
  });

  it('works correctly after clear + re-push', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    rb.push(10);
    rb.push(20);
    expect(rb.toArray()).toEqual([10, 20]);
  });

  it('wraps around multiple full cycles', () => {
    const rb = new RingBuffer<number>(2);
    for (let i = 0; i < 10; i++) rb.push(i);
    // Last 2 items: 8, 9
    expect(rb.toArray()).toEqual([8, 9]);
  });
});

// ─── redact ───────────────────────────────────────────────────────

describe('redact', () => {
  it('redacts sensitive object keys (password, token, secret, apiKey, authorization, credential)', () => {
    const obj = {
      password: 'hunter2',
      token: 'abc123',
      secret: 'mysecret',
      apiKey: 'key-xyz',
      authorization: 'Bearer xyz',
      credential: 'cred',
      safe: 'visible',
    };
    const result = redact(obj);
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('"safe":"visible"');
    expect(result).not.toContain('hunter2');
    expect(result).not.toContain('abc123');
    expect(result).not.toContain('mysecret');
  });

  it('leaves non-sensitive keys intact', () => {
    const obj = { name: 'test', count: 42 };
    const result = redact(obj);
    expect(result).toContain('test');
    expect(result).toContain('42');
  });

  it('handles circular references without crashing', () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const result = redact(obj);
    expect(result).toContain('[circular]');
    expect(result).not.toThrow; // just checking it didn't throw
  });

  it('handles null', () => {
    expect(redact(null)).toBe('null');
  });

  it('handles undefined', () => {
    expect(redact(undefined)).toBe('undefined');
  });

  it('handles bigint inside objects', () => {
    // bigint can't be directly in JSON, safeStringify converts it
    const result = redact({ val: BigInt(123) });
    expect(result).toContain('123');
  });

  it('redacts dak_ tokens with 8+ alphanumeric chars after prefix', () => {
    // Regex: /dak_[A-Za-z0-9]{8,}/ — matches longest run of alphanums after dak_
    // Token: dak_c2ldRoG4_vX5BG3t... — underscore breaks the match
    // So dak_c2ldRoG4 is matched (8 chars), rest stays
    const result = redact('dak_c2ldRoG4_vX5BG3tJZgzdZZsJm21sHXvUFVgJpowHmw');
    expect(result).toContain('dak_[REDACTED]');
    expect(result).not.toContain('c2ldRoG4');
  });

  it('redacts dak_ token that is purely alphanumeric', () => {
    const result = redact('dak_abcdefghijklmnop');
    expect(result).toBe('dak_[REDACTED]');
  });

  it('does NOT redact dak_ with fewer than 8 chars', () => {
    const result = redact('dak_short');
    // 'short' is 5 chars — below 8 threshold
    expect(result).toBe('dak_short');
  });

  it('redacts sk- OpenAI tokens', () => {
    const result = redact('sk-abcdefghij12345678');
    expect(result).toBe('sk-[REDACTED]');
  });

  it('redacts Bearer tokens (case-insensitive)', () => {
    const result = redact('bearer abcdefghij12345678');
    expect(result).toBe('Bearer [REDACTED]');
  });

  it('truncates long strings', () => {
    const long = 'x'.repeat(500);
    const result = redact(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('handles nested sensitive keys', () => {
    const obj = { outer: { inner: { password: 'deep-secret' } } };
    const result = redact(obj);
    expect(result).not.toContain('deep-secret');
    expect(result).toContain('[REDACTED]');
  });

  it('handles plain strings without transformation', () => {
    expect(redact('hello world')).toBe('hello world');
  });

  it('handles numbers', () => {
    expect(redact(42)).toBe('42');
  });

  it('handles boolean', () => {
    expect(redact(true)).toBe('true');
  });
});

// ─── TelemetryBus ─────────────────────────────────────────────────

describe('TelemetryBus', () => {
  let bus: TelemetryBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new TelemetryBus();
  });

  afterEach(() => {
    bus.stopTick();
    vi.useRealTimers();
  });

  // ── Snapshot basics ──

  it('initial snapshot is disconnected with empty collections', () => {
    const view = bus.getSnapshotView();
    expect(view.connectionState).toBe('disconnected');
    expect(view.connectedAt).toBeNull();
    expect(view.tools).toEqual([]);
    expect(view.setupSteps).toEqual([]);
    expect(view.recentCalls).toEqual([]);
    expect(view.recentErrors).toEqual([]);
    expect(view.inFlightCalls).toEqual([]);
    expect(view.reloading).toBe(false);
  });

  it('getSnapshotView returns new object each call (no shared refs)', () => {
    const a = bus.getSnapshotView();
    const b = bus.getSnapshotView();
    expect(a).not.toBe(b);
    expect(a.tools).not.toBe(b.tools);
  });

  // ── Connection state ──

  it('setConnectionState("connected") sets connectedAt', () => {
    vi.setSystemTime(1000);
    bus.setConnectionState('connected');
    const view = bus.getSnapshotView();
    expect(view.connectionState).toBe('connected');
    expect(view.connectedAt).toBe(1000);
  });

  it('setConnectionState("disconnected") clears connectedAt', () => {
    bus.setConnectionState('connected');
    bus.setConnectionState('disconnected');
    expect(bus.getSnapshotView().connectedAt).toBeNull();
  });

  it('setReconnecting sets state to reconnecting but does NOT clear connectedAt', () => {
    vi.setSystemTime(1000);
    bus.setConnectionState('connected');
    bus.setReconnecting(1);
    const view = bus.getSnapshotView();
    expect(view.connectionState).toBe('reconnecting');
    // connectedAt preserved — reconnecting doesn't mean "lost"
    expect(view.connectedAt).toBe(1000);
  });

  // ── Tools ──

  it('setTools updates snapshot', () => {
    const tools = [{ name: 'read_file', server: 'filesystem' }];
    bus.setTools(tools);
    expect(bus.getSnapshotView().tools).toEqual(tools);
  });

  // ── Setup steps ──

  it('setSetupStep adds to setupSteps', () => {
    bus.setSetupStep('config', 'ok', './delegate.yaml');
    const steps = bus.getSnapshotView().setupSteps;
    expect(steps.length).toBe(1);
    expect(steps[0][0]).toBe('config');
    expect(steps[0][1].status).toBe('ok');
    expect(steps[0][1].detail).toBe('./delegate.yaml');
  });

  it('setSetupStep overwrites same key', () => {
    bus.setSetupStep('ws', 'pending', 'connecting...');
    bus.setSetupStep('ws', 'ok', 'Connected');
    const steps = bus.getSnapshotView().setupSteps;
    expect(steps.length).toBe(1);
    expect(steps[0][1].status).toBe('ok');
  });

  // ── Tool call lifecycle ──

  it('emitToolStart adds to inFlightCalls', () => {
    vi.setSystemTime(5000);
    bus.emitToolStart('call-1', 'read_file', 'filesystem');
    const view = bus.getSnapshotView();
    expect(view.inFlightCalls.length).toBe(1);
    expect(view.inFlightCalls[0][0]).toBe('call-1');
    expect(view.inFlightCalls[0][1].tool).toBe('read_file');
    expect(view.inFlightCalls[0][1].startedAt).toBe(5000);
    expect(bus.inFlightSize).toBe(1);
  });

  it('emitToolEnd moves call from inFlight to recentCalls with duration', () => {
    vi.setSystemTime(1000);
    bus.emitToolStart('call-1', 'read_file', 'filesystem');

    vi.setSystemTime(1500);
    bus.emitToolEnd('call-1', 'file contents here', false);

    const view = bus.getSnapshotView();
    expect(view.inFlightCalls.length).toBe(0);
    expect(view.recentCalls.length).toBe(1);

    const call = view.recentCalls[0];
    expect(call.callId).toBe('call-1');
    expect(call.tool).toBe('read_file');
    expect(call.server).toBe('filesystem');
    expect(call.durationMs).toBe(500);
    expect(call.ok).toBe(true);
    expect(call.startedAt).toBe(1000);
    expect(call.endedAt).toBe(1500);
  });

  it('emitToolEnd with isError=true sets ok=false', () => {
    bus.emitToolStart('call-err', 'bad_tool', 'srv');
    bus.emitToolEnd('call-err', 'something broke', true);

    const call = bus.getSnapshotView().recentCalls[0];
    expect(call.ok).toBe(false);
  });

  it('emitToolEnd with unknown callId is a no-op (no crash)', () => {
    // Should not throw, should not add to recentCalls
    bus.emitToolEnd('nonexistent', 'data', false);
    expect(bus.getSnapshotView().recentCalls.length).toBe(0);
  });

  it('emitToolEnd redacts sensitive content in preview', () => {
    bus.emitToolStart('call-secret', 'tool', 'srv');
    bus.emitToolEnd('call-secret', { password: 'hunter2' }, false);
    const call = bus.getSnapshotView().recentCalls[0];
    expect(call.preview).toContain('[REDACTED]');
    expect(call.preview).not.toContain('hunter2');
  });

  // ── Errors ──

  it('pushError adds to recentErrors', () => {
    // Must subscribe to 'error' event — Node EventEmitter throws on unhandled 'error'
    bus.on('error', () => {});
    bus.pushError('connection lost', 'filesystem');
    const errors = bus.getSnapshotView().recentErrors;
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('connection lost');
    expect(errors[0].server).toBe('filesystem');
  });

  // ── Clear ──

  it('clearRecent empties both ring buffers', () => {
    bus.on('error', () => {}); // prevent Node unhandled 'error' throw
    bus.emitToolStart('c1', 'tool', 'srv');
    bus.emitToolEnd('c1', 'ok', false);
    bus.pushError('err');
    bus.clearRecent();

    const view = bus.getSnapshotView();
    expect(view.recentCalls).toEqual([]);
    expect(view.recentErrors).toEqual([]);
  });

  // ── Reload ──

  it('setReloading updates snapshot and getter', () => {
    bus.setReloading(true);
    expect(bus.isReloading).toBe(true);
    expect(bus.getSnapshotView().reloading).toBe(true);

    bus.setReloading(false);
    expect(bus.isReloading).toBe(false);
  });

  // ── subscribeAll ──

  it('subscribeAll fires on state-change events', () => {
    const listener = vi.fn();
    bus.subscribeAll(listener);

    bus.setConnectionState('connected');      // connection_state
    bus.setReconnecting(1);                   // reconnecting
    bus.setTools([]);                          // tools_loaded
    bus.emitToolStart('c', 't', 's');         // tool_call_start
    bus.emitToolEnd('c', '', false);          // tool_call_end
    bus.setSetupStep('k', 'ok', 'd');         // setup_step
    bus.pushError('e');                        // error
    bus.setReloading(true);                   // reload_state
    bus.clearRecent();                        // cleared

    expect(listener).toHaveBeenCalledTimes(9);
  });

  it('subscribeAll does NOT fire on tick', () => {
    const listener = vi.fn();
    bus.subscribeAll(listener);

    bus.startProcessTick();
    vi.advanceTimersByTime(60_000); // trigger tick

    // listener should not have been called by tick
    expect(listener).toHaveBeenCalledTimes(0);
  });

  it('subscribeAll unsub function works', () => {
    const listener = vi.fn();
    const unsub = bus.subscribeAll(listener);

    bus.setConnectionState('connected');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    bus.setConnectionState('disconnected');
    // Should still be 1 — unsubscribed
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ── Hot path getters ──

  it('connectionState getter reflects current state', () => {
    expect(bus.connectionState).toBe('disconnected');
    bus.setConnectionState('connected');
    expect(bus.connectionState).toBe('connected');
  });

  it('inFlightSize reflects current count', () => {
    expect(bus.inFlightSize).toBe(0);
    bus.emitToolStart('a', 't', 's');
    expect(bus.inFlightSize).toBe(1);
    bus.emitToolStart('b', 't', 's');
    expect(bus.inFlightSize).toBe(2);
    bus.emitToolEnd('a', '', false);
    expect(bus.inFlightSize).toBe(1);
  });

  // ── Tick timers ──

  it('startProcessTick emits tick at 60s interval', () => {
    const tickListener = vi.fn();
    bus.on('tick', tickListener);

    bus.startProcessTick();
    vi.advanceTimersByTime(60_000);
    expect(tickListener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(tickListener).toHaveBeenCalledTimes(2);
  });

  it('stopTick stops all timers', () => {
    const tickListener = vi.fn();
    bus.on('tick', tickListener);

    bus.startProcessTick();
    bus.stopTick();
    vi.advanceTimersByTime(120_000);
    expect(tickListener).toHaveBeenCalledTimes(0);
  });

  it('resetToFastTick cancels scheduled slow tick upgrade', () => {
    const tickListener = vi.fn();
    bus.on('tick', tickListener);

    bus.startProcessTick();
    bus.setConnectionState('connected');
    bus.scheduleSlowTick();

    // Before 5min: reset to fast
    vi.advanceTimersByTime(60_000);
    bus.resetToFastTick();

    // Advance past the 5min mark — slow tick should NOT have activated
    vi.advanceTimersByTime(300_000);

    // Should have ticks at 60s intervals, not 300s
    // After resetToFastTick: new epoch, 60s ticks
    // 300_000 / 60_000 = 5 ticks
    expect(tickListener.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});
