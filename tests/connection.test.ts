/**
 * Tests for DelegateConnection (src/connection.ts)
 *
 * Strategy: Mock the `ws` module so `new WebSocket(url)` returns a controllable
 * mock. Private methods and state are accessed via `(conn as any)` when needed.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

let mockWsInstance: any = null;

vi.mock('ws', async () => {
  const { EventEmitter } = await import('events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    // instance mirrors of static values (ws library exposes both)
    OPEN = 1;
    CONNECTING = 0;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1; // OPEN by default
    url: string;
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    ping = vi.fn(); // DEL-4: WS-level ping support

    constructor(url: string) {
      super();
      this.url = url;
      mockWsInstance = this;
    }
  }
  return { default: MockWebSocket };
});

// Import AFTER the mock is registered
import { DelegateConnection, type ConnectionOptions } from '../src/connection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOptions(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    serverUrl: 'wss://example.com/ws',
    token: 'test-jwt-token',
    delegateId: 'test-delegate',
    capabilities: ['mcp_host'],
    ...overrides,
  };
}

/** Suppress console noise in tests */
function silenceConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

/**
 * Start a connect() call and immediately simulate WS open + successful auth.
 * Returns the resolved connection so tests can work with a "connected" instance.
 */
async function connectAndAuth(
  conn: DelegateConnection,
  authOverrides: Record<string, unknown> = {},
): Promise<void> {
  const connectPromise = conn.connect();

  // Wait a tick for the constructor to fire
  await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

  // Simulate WebSocket open
  mockWsInstance.emit('open');

  // Simulate successful auth
  const authMsg = JSON.stringify({
    type: 'delegate_auth_result',
    success: true,
    sessionId: 'sess-123',
    userId: 'user-456',
    ...authOverrides,
  });
  mockWsInstance.emit('message', Buffer.from(authMsg));

  await connectPromise;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DelegateConnection', () => {
  beforeEach(() => {
    silenceConsole();
    mockWsInstance = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Constructor + Defaults
  // =========================================================================

  describe('constructor and defaults', () => {
    it('sets default autoReconnect to true', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect((conn as any).options.autoReconnect).toBe(true);
    });

    it('sets default heartbeatInterval to 30000', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect((conn as any).options.heartbeatInterval).toBe(30000);
    });

    it('sets default maxReconnectAttempts to Infinity', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect((conn as any).options.maxReconnectAttempts).toBe(Infinity);
    });

    it('uses delegateId as delegateName when delegateName is not provided', () => {
      const conn = new DelegateConnection(defaultOptions({ delegateId: 'my-delegate' }));
      expect((conn as any).options.delegateName).toBe('my-delegate');
    });

    it('uses provided delegateName when specified', () => {
      const conn = new DelegateConnection(
        defaultOptions({ delegateId: 'my-delegate', delegateName: 'My Display Name' }),
      );
      expect((conn as any).options.delegateName).toBe('My Display Name');
    });

    it('sets default mcplCapabilities to empty array', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect((conn as any).options.mcplCapabilities).toEqual([]);
    });

    it('preserves user-supplied options', () => {
      const conn = new DelegateConnection(
        defaultOptions({
          autoReconnect: false,
          heartbeatInterval: 5000,
          maxReconnectAttempts: 3,
        }),
      );
      expect((conn as any).options.autoReconnect).toBe(false);
      expect((conn as any).options.heartbeatInterval).toBe(5000);
      expect((conn as any).options.maxReconnectAttempts).toBe(3);
    });

    it('initial state is disconnected', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect(conn.currentState).toBe('disconnected');
    });

    it('isConnected returns false initially', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect(conn.isConnected).toBe(false);
    });

    it('isMcpl returns false initially', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect(conn.isMcpl).toBe(false);
    });

    it('featureSets returns empty object initially', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect(conn.featureSets).toEqual({});
    });
  });

  // =========================================================================
  // connect() state guard
  // =========================================================================

  describe('connect() state guard', () => {
    it('throws when state is connecting', async () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).state = 'connecting';
      await expect(conn.connect()).rejects.toThrow('Cannot connect: state is connecting');
    });

    it('throws when state is authenticating', async () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).state = 'authenticating';
      await expect(conn.connect()).rejects.toThrow('Cannot connect: state is authenticating');
    });

    it('throws when state is connected', async () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).state = 'connected';
      await expect(conn.connect()).rejects.toThrow('Cannot connect: state is connected');
    });
  });

  // =========================================================================
  // disconnect()
  // =========================================================================

  describe('disconnect()', () => {
    it('sets intentionalClose to true', () => {
      const conn = new DelegateConnection(defaultOptions());
      conn.disconnect();
      expect((conn as any).intentionalClose).toBe(true);
    });

    it('sets state to disconnected', () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).state = 'connected';
      conn.disconnect();
      expect(conn.currentState).toBe('disconnected');
    });

    it('emits state_change when state actually changes', () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).state = 'connected';

      const spy = vi.fn();
      conn.on('state_change', spy);
      conn.disconnect();

      expect(spy).toHaveBeenCalledWith('disconnected');
    });

    it('cleans up WebSocket reference', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      expect((conn as any).ws).not.toBeNull();
      conn.disconnect();
      expect((conn as any).ws).toBeNull();
    });

    it('cleans up reconnect timer', () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).reconnectTimer = setTimeout(() => {}, 1000);
      conn.disconnect();
      expect((conn as any).reconnectTimer).toBeNull();
    });

    it('cleans up heartbeat timer', () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).heartbeatTimer = setInterval(() => {}, 1000);
      conn.disconnect();
      expect((conn as any).heartbeatTimer).toBeNull();
    });

    it('cleans up bare ack timer', () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).rcBareAckTimer = setTimeout(() => {}, 100);
      conn.disconnect();
      expect((conn as any).rcBareAckTimer).toBeNull();
    });
  });

  // =========================================================================
  // send() state guard
  // =========================================================================

  describe('send() state guard', () => {
    it('throws when ws is null', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect(() => conn.send({ type: 'ping' })).toThrow('Not connected');
    });

    it('throws when ws.readyState is not OPEN', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      // Change readyState to CLOSED
      mockWsInstance.readyState = 3; // CLOSED
      expect(() => conn.send({ type: 'ping' })).toThrow('Not connected');
    });

    it('sends JSON-stringified message when connected', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      mockWsInstance.send.mockClear();
      const message = { type: 'ping', timestamp: 12345 };
      conn.send(message);

      expect(mockWsInstance.send).toHaveBeenCalledWith(JSON.stringify(message));
    });
  });

  // =========================================================================
  // send() — MCPL ReliableChannel framing
  // =========================================================================

  describe('send() — MCPL RC framing', () => {
    it('wraps mcpl/ messages in RC frames when isMcpl is true', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      mockWsInstance.send.mockClear();

      const message = { type: 'mcpl/push_event', id: 'e1' };
      conn.send(message);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.seq).toBe(1);
      expect(sent.ack).toBe(0);
      expect(sent.payload).toEqual(message);
    });

    it('does NOT wrap mcpl/hello in RC frames', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      mockWsInstance.send.mockClear();

      const message = { type: 'mcpl/hello', protocolVersion: 'mcpl-1.0' };
      conn.send(message);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent).toEqual(message); // sent raw, no seq/ack
    });

    it('does NOT wrap non-mcpl messages in RC frames even when isMcpl', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      mockWsInstance.send.mockClear();

      const message = { type: 'tool_manifest', delegateId: 'x', tools: [] };
      conn.send(message);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent).toEqual(message);
    });

    it('increments rcOutSeq for each MCPL RC message', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      mockWsInstance.send.mockClear();

      conn.send({ type: 'mcpl/push_event', id: '1' });
      conn.send({ type: 'mcpl/push_event', id: '2' });
      conn.send({ type: 'mcpl/push_event', id: '3' });

      expect((conn as any).rcOutSeq).toBe(3);

      const frame1 = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      const frame2 = JSON.parse(mockWsInstance.send.mock.calls[1][0]);
      const frame3 = JSON.parse(mockWsInstance.send.mock.calls[2][0]);
      expect(frame1.seq).toBe(1);
      expect(frame2.seq).toBe(2);
      expect(frame3.seq).toBe(3);
    });

    it('stores frames in rcBuffer for potential resend', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      conn.send({ type: 'mcpl/push_event', id: '1' });

      expect((conn as any).rcBuffer.size).toBe(1);
      expect((conn as any).rcBuffer.has(1)).toBe(true);
    });

    it('piggybacks ack (rcInSeq) on outgoing RC frames', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      (conn as any).rcInSeq = 5; // simulate having received 5 frames
      mockWsInstance.send.mockClear();

      conn.send({ type: 'mcpl/push_event', id: '1' });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.ack).toBe(5);
    });

    it('closes connection on backpressure (too many unacked)', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      (conn as any).rcOutSeq = 64;
      (conn as any).rcLastAckedSeq = 0; // 64 unacked
      mockWsInstance.send.mockClear();

      conn.send({ type: 'mcpl/push_event', id: 'overflow' });

      expect(mockWsInstance.close).toHaveBeenCalledWith(1008, 'backpressure: too many unacked frames');
      expect(mockWsInstance.send).not.toHaveBeenCalled();
    });

    it('cancels pending bare ack timer when piggybacking ack', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      // Simulate a pending bare ack timer
      (conn as any).rcBareAckTimer = setTimeout(() => {}, 1000);
      expect((conn as any).rcBareAckTimer).not.toBeNull();

      conn.send({ type: 'mcpl/push_event', id: '1' });

      expect((conn as any).rcBareAckTimer).toBeNull();
    });
  });

  // =========================================================================
  // sendToolManifest()
  // =========================================================================

  describe('sendToolManifest()', () => {
    it('sends correct JSON format without warnings', async () => {
      const conn = new DelegateConnection(defaultOptions({ delegateId: 'my-del' }));
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      const tools = [
        { name: 'calc', description: 'Calculator', inputSchema: { type: 'object' as const, properties: {} } },
      ];
      conn.sendToolManifest(tools);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('tool_manifest');
      expect(sent.delegateId).toBe('my-del');
      expect(sent.tools).toEqual(tools);
      expect(sent.timestamp).toBeDefined(); // Feature 4: timestamp for toolset history
      expect(sent).not.toHaveProperty('warnings');
    });

    it('includes warnings when provided', async () => {
      const conn = new DelegateConnection(defaultOptions({ delegateId: 'my-del' }));
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      const tools = [
        { name: 'calc', description: 'Calculator', inputSchema: { type: 'object' as const, properties: {} } },
      ];
      const warnings = [
        { toolName: 'calc', fromServer: 'server-a', conflictsWith: 'server-b' },
      ];
      conn.sendToolManifest(tools, warnings);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.warnings).toEqual(warnings);
    });

    it('does not include warnings key when warnings array is empty', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendToolManifest([], []);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent).not.toHaveProperty('warnings');
    });

    it('includes ISO timestamp in manifest (Feature 4)', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendToolManifest([]);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.timestamp).toBeDefined();
      // Verify it's a valid ISO date string
      expect(new Date(sent.timestamp).toISOString()).toBe(sent.timestamp);
    });

    it('includes reason when provided (Feature 4)', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendToolManifest([], undefined, 'server_enabled:echo');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.reason).toBe('server_enabled:echo');
    });

    it('does not include reason key when reason is omitted', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendToolManifest([]);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent).not.toHaveProperty('reason');
    });

    it('includes both reason and warnings when provided', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      const warnings = [{ toolName: 'x', fromServer: 'a', conflictsWith: 'b' }];
      conn.sendToolManifest([], warnings, 'config_reload');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.reason).toBe('config_reload');
      expect(sent.warnings).toEqual(warnings);
      expect(sent.timestamp).toBeDefined();
    });
  });

  // =========================================================================
  // sendToolCallResponse()
  // =========================================================================

  describe('sendToolCallResponse()', () => {
    it('sends correct JSON format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendToolCallResponse('req-1', 'tu-1', 'result text');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent).toEqual({
        type: 'tool_call_response',
        requestId: 'req-1',
        toolUseId: 'tu-1',
        result: { content: 'result text', isError: false },
      });
    });

    it('sends isError=true when specified', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendToolCallResponse('req-1', 'tu-1', 'error msg', true);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.result.isError).toBe(true);
    });

    it('supports array content', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      const content = [{ type: 'text', text: 'hello' }];
      conn.sendToolCallResponse('req-1', 'tu-1', content);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.result.content).toEqual(content);
    });
  });

  // =========================================================================
  // sendTriggerInference()
  // =========================================================================

  describe('sendTriggerInference()', () => {
    it('sends correct JSON format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendTriggerInference({
        triggerId: 'trig-1',
        source: 'webhook',
        context: { key: 'val' },
      });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('trigger_inference');
      expect(sent.triggerId).toBe('trig-1');
      expect(sent.source).toBe('webhook');
      expect(sent.context).toEqual({ key: 'val' });
    });
  });

  // =========================================================================
  // URL construction (doConnect)
  // =========================================================================

  describe('URL construction via doConnect', () => {
    it('sends token in first message for JWT tokens (not in URL)', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ serverUrl: 'wss://example.com/ws', token: 'jwt-abc123' }),
      );

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      // Auth credentials should NOT be in URL
      expect(mockWsInstance.url).not.toContain('token=jwt');
      expect(mockWsInstance.url).not.toContain('apiKey=');
      expect(mockWsInstance.url).toContain('role=delegate');

      // Clean up: simulate open + auth to resolve the promise
      mockWsInstance.emit('open');

      // First message should be delegate_auth with token
      expect(mockWsInstance.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'delegate_auth', token: 'jwt-abc123', delegateId: 'test-delegate' }),
      );

      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'delegate_auth_result', success: true, sessionId: 's', userId: 'u' })),
      );
      await connectPromise;
    });

    it('sends apiKey in first message for dak_ tokens (not in URL)', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ serverUrl: 'wss://example.com/ws', token: 'dak_abc123' }),
      );

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      // Auth credentials should NOT be in URL
      expect(mockWsInstance.url).not.toContain('apiKey=');
      expect(mockWsInstance.url).not.toContain('token=');

      mockWsInstance.emit('open');

      // First message should be delegate_auth with apiKey
      expect(mockWsInstance.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'delegate_auth', apiKey: 'dak_abc123', delegateId: 'test-delegate' }),
      );

      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'delegate_auth_result', success: true, sessionId: 's', userId: 'u' })),
      );
      await connectPromise;
    });

    it('includes role=delegate and delegateId params', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ delegateId: 'my-del-id' }),
      );

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      expect(mockWsInstance.url).toContain('role=delegate');
      expect(mockWsInstance.url).toContain('delegateId=my-del-id');

      mockWsInstance.emit('open');
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'delegate_auth_result', success: true, sessionId: 's', userId: 'u' })),
      );
      await connectPromise;
    });

    it('uses & separator if serverUrl already has query params', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ serverUrl: 'wss://example.com/ws?existing=1' }),
      );

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      // Should have & after existing param for role/delegateId (no auth in URL)
      expect(mockWsInstance.url).toMatch(/\?existing=1&role=delegate/);
      expect(mockWsInstance.url).not.toContain('token=');

      mockWsInstance.emit('open');
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'delegate_auth_result', success: true, sessionId: 's', userId: 'u' })),
      );
      await connectPromise;
    });

    it('encodes special characters in delegateId', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ delegateId: 'my delegate/special' }),
      );

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      expect(mockWsInstance.url).toContain('delegateId=my%20delegate%2Fspecial');

      mockWsInstance.emit('open');
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'delegate_auth_result', success: true, sessionId: 's', userId: 'u' })),
      );
      await connectPromise;
    });
  });

  // =========================================================================
  // Connection flow
  // =========================================================================

  describe('connection flow', () => {
    it('transitions through connecting -> authenticating -> connected (legacy)', async () => {
      const conn = new DelegateConnection(defaultOptions());
      const states: string[] = [];
      conn.on('state_change', (s) => states.push(s));

      await connectAndAuth(conn);

      expect(states).toEqual(['connecting', 'authenticating', 'connected']);
      expect(conn.isConnected).toBe(true);
    });

    it('emits connected event with sessionId and userId', async () => {
      const conn = new DelegateConnection(defaultOptions());
      const connectedSpy = vi.fn();
      conn.on('connected', connectedSpy);

      await connectAndAuth(conn);

      expect(connectedSpy).toHaveBeenCalledWith('sess-123', 'user-456');
    });

    it('stores sessionId and userId', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      expect((conn as any).sessionId).toBe('sess-123');
      expect((conn as any).userId).toBe('user-456');
    });

    it('resets reconnectAttempts on successful connection', async () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).reconnectAttempts = 5;
      await connectAndAuth(conn);

      expect((conn as any).reconnectAttempts).toBe(0);
    });

    it('rejects on auth failure', async () => {
      const conn = new DelegateConnection(defaultOptions());

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      mockWsInstance.emit('open');
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'delegate_auth_result',
          success: false,
          error: 'invalid token',
        })),
      );

      await expect(connectPromise).rejects.toThrow('Authentication failed: invalid token');
      expect(conn.currentState).toBe('disconnected');
    });

    it('rejects on connection timeout', async () => {
      const conn = new DelegateConnection(defaultOptions());
      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      // Advance past the 15s timeout
      vi.advanceTimersByTime(15001);

      await expect(connectPromise).rejects.toThrow('Connection timeout');
    });

    it('rejects when WebSocket closes during setup', async () => {
      const conn = new DelegateConnection(defaultOptions());
      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      mockWsInstance.emit('close', 1006, Buffer.from('abnormal'));

      await expect(connectPromise).rejects.toThrow('Connection closed during setup');
    });

    it('emits error event on WebSocket error', async () => {
      const conn = new DelegateConnection(defaultOptions());
      const errorSpy = vi.fn();
      conn.on('error', errorSpy);

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      const wsError = new Error('ECONNREFUSED');
      mockWsInstance.emit('error', wsError);

      // Also close the socket to resolve the promise
      mockWsInstance.emit('close', 1006, Buffer.from('error'));

      await expect(connectPromise).rejects.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(wsError);
    });
  });

  // =========================================================================
  // MCPL connection flow
  // =========================================================================

  describe('MCPL connection flow', () => {
    it('sends mcpl/hello after auth success when mcplCapabilities configured', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ mcplCapabilities: ['context_hooks', 'push_events'] }),
      );

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      mockWsInstance.emit('open');
      mockWsInstance.send.mockClear();

      // Auth success
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'delegate_auth_result',
          success: true,
          sessionId: 's1',
          userId: 'u1',
        })),
      );

      // Should have sent mcpl/hello
      expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
      const hello = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(hello.type).toBe('mcpl/hello');
      expect(hello.protocolVersion).toBe('mcpl-1.0');
      expect(hello.capabilities).toEqual(['context_hooks', 'push_events']);

      // Should still be authenticating (waiting for mcpl/ack)
      expect(conn.currentState).toBe('authenticating');

      // Now send mcpl/ack as JSON-RPC 2.0 response (server encodes via McplCodec)
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({
          jsonrpc: '2.0',
          id: hello.requestId,
          result: {
            sessionId: 'mcpl-sess-1',
            negotiatedCapabilities: ['context_hooks'],
            featureSets: { server1: { contextHooks: true, pushEvents: false, inferenceRequests: false, toolManagement: false } },
          },
        })),
      );

      await connectPromise;

      expect(conn.currentState).toBe('connected');
      expect(conn.isMcpl).toBe(true);
      expect(conn.featureSets).toHaveProperty('server1');
    });

    it('emits mcpl_ack event on successful MCPL handshake', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ mcplCapabilities: ['context_hooks'] }),
      );
      const ackSpy = vi.fn();
      conn.on('mcpl_ack', ackSpy);

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      mockWsInstance.emit('open');
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'delegate_auth_result',
          success: true,
          sessionId: 's1',
          userId: 'u1',
        })),
      );
      // Capture hello requestId for JSON-RPC correlation
      const hello = JSON.parse(mockWsInstance.send.mock.calls[mockWsInstance.send.mock.calls.length - 1][0]);
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({
          jsonrpc: '2.0',
          id: hello.requestId,
          result: {
            sessionId: 'mcpl-sess-1',
            negotiatedCapabilities: ['context_hooks'],
            featureSets: {},
          },
        })),
      );

      await connectPromise;
      expect(ackSpy).toHaveBeenCalledTimes(1);
    });

    it('resets RC state on new MCPL session (no resumedFromSeq)', async () => {
      const conn = new DelegateConnection(
        defaultOptions({ mcplCapabilities: ['context_hooks'] }),
      );

      // Pre-set RC state to simulate a prior session
      (conn as any).rcOutSeq = 10;
      (conn as any).rcInSeq = 5;
      (conn as any).rcLastAckedSeq = 3;

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

      mockWsInstance.emit('open');
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({
          type: 'delegate_auth_result',
          success: true,
          sessionId: 's1',
          userId: 'u1',
        })),
      );
      // Capture hello requestId for JSON-RPC correlation
      const hello3 = JSON.parse(mockWsInstance.send.mock.calls[mockWsInstance.send.mock.calls.length - 1][0]);
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({
          jsonrpc: '2.0',
          id: hello3.requestId,
          result: {
            sessionId: 'mcpl-sess-new',
            negotiatedCapabilities: [],
            featureSets: {},
          },
        })),
      );

      await connectPromise;

      expect((conn as any).rcOutSeq).toBe(0);
      expect((conn as any).rcInSeq).toBe(0);
      expect((conn as any).rcLastAckedSeq).toBe(0);
    });
  });

  // =========================================================================
  // setState()
  // =========================================================================

  describe('setState()', () => {
    it('emits state_change event when state changes', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('state_change', spy);

      (conn as any).setState('connecting');
      expect(spy).toHaveBeenCalledWith('connecting');
    });

    it('does not emit when state is the same', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();

      // State starts as 'disconnected'
      conn.on('state_change', spy);
      (conn as any).setState('disconnected');

      expect(spy).not.toHaveBeenCalled();
    });

    it('updates currentState getter', () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).setState('connecting');
      expect(conn.currentState).toBe('connecting');
    });

    it('updates isConnected getter', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect(conn.isConnected).toBe(false);

      (conn as any).setState('connected');
      expect(conn.isConnected).toBe(true);

      (conn as any).setState('disconnected');
      expect(conn.isConnected).toBe(false);
    });
  });

  // =========================================================================
  // handleMessage (private)
  // =========================================================================

  describe('handleMessage()', () => {
    it('emits tool_call_request for valid tool_call_request message', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('tool_call_request', spy);

      const msg = {
        type: 'tool_call_request',
        requestId: 'req-1',
        conversationId: 'conv-1',
        tool: { id: 't1', name: 'calc', input: {} },
        timeout: 30000,
      };
      (conn as any).handleMessage(msg);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].requestId).toBe('req-1');
    });

    it('emits trigger_inference_result for valid message', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('trigger_inference_result', spy);

      const msg = {
        type: 'trigger_inference_result',
        triggerId: 'trig-1',
        success: true,
        conversationId: 'conv-1',
      };
      (conn as any).handleMessage(msg);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits tool_manifest_ack for valid message', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('tool_manifest_ack', spy);

      const msg = {
        type: 'tool_manifest_ack',
        toolCount: 2,
        tools: ['calc', 'weather'],
      };
      (conn as any).handleMessage(msg);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].toolCount).toBe(2);
    });

    it('does not emit for pong message (heartbeat only)', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('pong', spy);

      const msg = { type: 'pong', timestamp: Date.now() };
      (conn as any).handleMessage(msg);

      // pong is handled silently — no event emitted
      expect(spy).not.toHaveBeenCalled();
    });

    it('does not crash on unknown message type', () => {
      const conn = new DelegateConnection(defaultOptions());

      // Should not throw
      expect(() => {
        (conn as any).handleMessage({ type: 'unknown_future_message', data: 'x' });
      }).not.toThrow();
    });

    it('routes mcpl/ prefixed messages to handleMcplMessage', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      const msg = { type: 'mcpl/beforeInference', requestId: 'r1', conversationId: 'c1' };
      (conn as any).handleMessage(msg);

      expect(spy).toHaveBeenCalledWith(msg);
    });
  });

  // =========================================================================
  // handleMcplMessage (private)
  // =========================================================================

  describe('handleMcplMessage()', () => {
    it('emits mcpl_before_inference for mcpl/beforeInference', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_before_inference', spy);

      (conn as any).handleMcplMessage({ type: 'mcpl/beforeInference', requestId: 'r1', conversationId: 'c1' });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_after_inference and auto-acks for mcpl/afterInference', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = false; // avoid RC framing for simplicity
      const spy = vi.fn();
      conn.on('mcpl_after_inference', spy);
      mockWsInstance.send.mockClear();

      (conn as any).handleMcplMessage({ type: 'mcpl/afterInference', requestId: 'r1', conversationId: 'c1' });

      expect(spy).toHaveBeenCalledTimes(1);
      // Should have auto-sent afterInference_ack
      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/afterInference_ack');
      expect(sent.requestId).toBe('r1');
    });

    it('emits mcpl_inference_response for mcpl/inference_response', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_inference_response', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/inference_response',
        requestId: 'r1',
        success: true,
        content: 'hello',
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_inference_chunk for mcpl/inference_chunk', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_inference_chunk', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/inference_chunk',
        requestId: 'r1',
        chunkIndex: 0,
        delta: 'hel',
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_scope_change_result for mcpl/scope_change_result', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_scope_change_result', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/scope_change_result',
        requestId: 'r1',
        approved: true,
        newCapabilities: ['context_hooks'],
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_connect_server for mcpl/connect_server', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_connect_server', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/connect_server',
        url: 'http://localhost:3000',
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_model_info_response for mcpl/model_info_response', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_model_info_response', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/model_info_response',
        requestId: 'r1',
        modelId: 'gpt-4',
        provider: 'openai',
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_scope_elevate_result for mcpl/scope_elevate_result', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_scope_elevate_result', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/scope_elevate_result',
        requestId: 'r1',
        approved: true,
        newCapabilities: ['push_events'],
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_state_patch_result for mcpl/state_patch_result', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_state_patch_result', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/state_patch_result',
        requestId: 'r1',
        success: true,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_state_response for mcpl/state_response', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_state_response', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/state_response',
        requestId: 'r1',
        state: { key: 'val' },
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('emits mcpl_checkpoint_list_response for mcpl/checkpoint_list_response', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('mcpl_checkpoint_list_response', spy);

      (conn as any).handleMcplMessage({
        type: 'mcpl/checkpoint_list_response',
        requestId: 'r1',
        current: 'cp-1',
        checkpoints: [],
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not crash on unhandled MCPL message type', () => {
      const conn = new DelegateConnection(defaultOptions());
      expect(() => {
        (conn as any).handleMcplMessage({ type: 'mcpl/future_unknown' });
      }).not.toThrow();
    });
  });

  // =========================================================================
  // ReliableChannel — handleReliableFrame (private)
  // =========================================================================

  describe('handleReliableFrame()', () => {
    it('delivers in-order frame immediately and updates rcInSeq', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      // rcInSeq starts at 0, so frame seq=1 is in-order
      const payload = { type: 'mcpl/beforeInference', requestId: 'r1' };
      (conn as any).handleReliableFrame({ seq: 1, ack: 0, payload });

      expect(spy).toHaveBeenCalledWith(payload);
      expect((conn as any).rcInSeq).toBe(1);
    });

    it('ignores duplicate frames (seq <= rcInSeq)', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      (conn as any).rcInSeq = 5;

      // seq=5 is duplicate (already received)
      (conn as any).handleReliableFrame({ seq: 5, ack: 0, payload: { type: 'mcpl/test' } });
      // seq=3 is also duplicate
      (conn as any).handleReliableFrame({ seq: 3, ack: 0, payload: { type: 'mcpl/test' } });

      expect(spy).not.toHaveBeenCalled();
      expect((conn as any).rcInSeq).toBe(5);
    });

    it('buffers out-of-order frame in rcPending', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      // rcInSeq=0, but we receive seq=3 (skipping 1 and 2)
      const payload = { type: 'mcpl/test', seq: 3 };
      (conn as any).handleReliableFrame({ seq: 3, ack: 0, payload });

      expect(spy).not.toHaveBeenCalled(); // not delivered yet
      expect((conn as any).rcPending.has(3)).toBe(true);
      expect((conn as any).rcInSeq).toBe(0);
    });

    it('drains buffered frames when gap is filled', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      // Buffer seq 2 and 3 (out of order)
      (conn as any).handleReliableFrame({ seq: 2, ack: 0, payload: { type: 'mcpl/msg2' } });
      (conn as any).handleReliableFrame({ seq: 3, ack: 0, payload: { type: 'mcpl/msg3' } });

      expect(spy).not.toHaveBeenCalled();

      // Now receive seq 1 (fills the gap)
      (conn as any).handleReliableFrame({ seq: 1, ack: 0, payload: { type: 'mcpl/msg1' } });

      // All three should be delivered in order
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy.mock.calls[0][0].type).toBe('mcpl/msg1');
      expect(spy.mock.calls[1][0].type).toBe('mcpl/msg2');
      expect(spy.mock.calls[2][0].type).toBe('mcpl/msg3');

      expect((conn as any).rcInSeq).toBe(3);
      expect((conn as any).rcPending.size).toBe(0);
    });

    it('handles bare ack frame (seq=0) — processes ack, no delivery', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      // Pre-populate buffer with outgoing frame
      (conn as any).rcBuffer.set(1, { seq: 1, ack: 0, payload: {} });
      (conn as any).rcBuffer.set(2, { seq: 2, ack: 0, payload: {} });

      // Receive bare ack for seq up to 1
      (conn as any).handleReliableFrame({ seq: 0, ack: 1 });

      expect(spy).not.toHaveBeenCalled();
      expect((conn as any).rcLastAckedSeq).toBe(1);
      expect((conn as any).rcBuffer.has(1)).toBe(false); // freed
      expect((conn as any).rcBuffer.has(2)).toBe(true);  // still pending
    });

    it('frees confirmed outbound frames from rcBuffer on ack', () => {
      const conn = new DelegateConnection(defaultOptions());

      (conn as any).rcBuffer.set(1, { seq: 1, ack: 0, payload: {} });
      (conn as any).rcBuffer.set(2, { seq: 2, ack: 0, payload: {} });
      (conn as any).rcBuffer.set(3, { seq: 3, ack: 0, payload: {} });

      // Receive frame with ack=2
      (conn as any).handleReliableFrame({ seq: 1, ack: 2, payload: { type: 'mcpl/test' } });

      expect((conn as any).rcLastAckedSeq).toBe(2);
      expect((conn as any).rcBuffer.has(1)).toBe(false);
      expect((conn as any).rcBuffer.has(2)).toBe(false);
      expect((conn as any).rcBuffer.has(3)).toBe(true);
    });

    it('handles frame without payload as bare ack', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      // seq=0 with no payload
      (conn as any).handleReliableFrame({ seq: 0, ack: 3 });

      expect(spy).not.toHaveBeenCalled();
      expect((conn as any).rcLastAckedSeq).toBe(3);
    });

    it('does not decrease rcLastAckedSeq on stale ack', () => {
      const conn = new DelegateConnection(defaultOptions());
      (conn as any).rcLastAckedSeq = 5;

      (conn as any).handleReliableFrame({ seq: 0, ack: 3 }); // ack=3 < current 5

      expect((conn as any).rcLastAckedSeq).toBe(5);
    });
  });

  // =========================================================================
  // scheduleBareAck (private)
  // =========================================================================

  describe('scheduleBareAck()', () => {
    it('schedules a bare ack after RC_BARE_ACK_DELAY', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      (conn as any).rcInSeq = 3;
      mockWsInstance.send.mockClear();

      (conn as any).scheduleBareAck();

      expect((conn as any).rcBareAckTimer).not.toBeNull();

      // Advance by the delay (50ms)
      vi.advanceTimersByTime(50);

      expect(mockWsInstance.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent).toEqual({ seq: 0, ack: 3 });
    });

    it('does not schedule duplicate bare ack if one is already pending', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      const originalTimer = setTimeout(() => {}, 1000);
      (conn as any).rcBareAckTimer = originalTimer;

      (conn as any).scheduleBareAck();

      // Timer should not have been replaced
      expect((conn as any).rcBareAckTimer).toBe(originalTimer);
    });

    it('does not send bare ack if ws is not open', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      mockWsInstance.readyState = 3; // CLOSED
      (conn as any).scheduleBareAck();
      vi.advanceTimersByTime(50);

      expect(mockWsInstance.send).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // resendBufferedAfter (private)
  // =========================================================================

  describe('resendBufferedAfter()', () => {
    it('resends frames after the given seq in order', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      // DEL-1: rcBuffer stores { frame, ts } — not bare frame objects
      const now = Date.now();
      (conn as any).rcBuffer.set(1, { frame: { seq: 1, ack: 0, payload: { type: 'mcpl/a' } }, ts: now });
      (conn as any).rcBuffer.set(2, { frame: { seq: 2, ack: 0, payload: { type: 'mcpl/b' } }, ts: now });
      (conn as any).rcBuffer.set(3, { frame: { seq: 3, ack: 0, payload: { type: 'mcpl/c' } }, ts: now });

      mockWsInstance.send.mockClear();
      (conn as any).resendBufferedAfter(1);

      expect(mockWsInstance.send).toHaveBeenCalledTimes(2);
      const sent1 = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      const sent2 = JSON.parse(mockWsInstance.send.mock.calls[1][0]);
      expect(sent1.seq).toBe(2);
      expect(sent2.seq).toBe(3);
    });

    it('does not resend frames at or before the given seq', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      // DEL-1: rcBuffer stores { frame, ts }
      const now = Date.now();
      (conn as any).rcBuffer.set(1, { frame: { seq: 1, ack: 0, payload: { type: 'mcpl/a' } }, ts: now });
      (conn as any).rcBuffer.set(2, { frame: { seq: 2, ack: 0, payload: { type: 'mcpl/b' } }, ts: now });

      mockWsInstance.send.mockClear();
      (conn as any).resendBufferedAfter(2);

      expect(mockWsInstance.send).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Reconnection logic
  // =========================================================================

  describe('reconnection', () => {
    it('uses exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s', () => {
      const conn = new DelegateConnection(defaultOptions());

      // Access the private scheduleReconnect to test delay calculation
      // The delay formula: Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000)
      // After scheduleReconnect increments reconnectAttempts:
      //   attempt 1 → 1000 * 2^0 = 1000ms
      //   attempt 2 → 1000 * 2^1 = 2000ms
      //   attempt 3 → 1000 * 2^2 = 4000ms
      //   attempt 4 → 1000 * 2^3 = 8000ms
      //   attempt 5 → 1000 * 2^4 = 16000ms
      //   attempt 6 → 1000 * 2^5 = 32000ms → capped at 30000ms

      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000];

      for (let i = 0; i < expectedDelays.length; i++) {
        const attempt = i; // reconnectAttempts before scheduleReconnect call
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        expect(delay).toBe(expectedDelays[i]);
      }
    });

    it('emits reconnecting event with attempt number', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('reconnecting', spy);

      (conn as any).scheduleReconnect();

      expect(spy).toHaveBeenCalledWith(1);
    });

    it('does not reconnect when maxReconnectAttempts reached', () => {
      const conn = new DelegateConnection(defaultOptions({ maxReconnectAttempts: 2 }));
      const spy = vi.fn();
      conn.on('reconnecting', spy);

      (conn as any).reconnectAttempts = 2;
      (conn as any).scheduleReconnect();

      expect(spy).not.toHaveBeenCalled();
      expect((conn as any).reconnectTimer).toBeNull();
    });

    it('does not reconnect on close code 4001 (name collision)', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      const reconnectSpy = vi.fn();
      conn.on('reconnecting', reconnectSpy);

      // Simulate close with 4001
      mockWsInstance.emit('close', 4001, Buffer.from('name collision'));

      // Advance timers to ensure no reconnect was scheduled
      vi.advanceTimersByTime(60000);

      expect(reconnectSpy).not.toHaveBeenCalled();
    });

    it('does not reconnect on intentional close', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any).intentionalClose = true;

      const reconnectSpy = vi.fn();
      conn.on('reconnecting', reconnectSpy);

      mockWsInstance.emit('close', 1000, Buffer.from('normal'));

      vi.advanceTimersByTime(60000);
      expect(reconnectSpy).not.toHaveBeenCalled();
    });

    it('does not reconnect when autoReconnect is false', async () => {
      const conn = new DelegateConnection(defaultOptions({ autoReconnect: false }));
      await connectAndAuth(conn);

      const reconnectSpy = vi.fn();
      conn.on('reconnecting', reconnectSpy);

      mockWsInstance.emit('close', 1006, Buffer.from('abnormal'));

      vi.advanceTimersByTime(60000);
      expect(reconnectSpy).not.toHaveBeenCalled();
    });

    it('schedules reconnect on unexpected disconnect', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      const reconnectSpy = vi.fn();
      conn.on('reconnecting', reconnectSpy);

      mockWsInstance.emit('close', 1006, Buffer.from('abnormal'));

      expect(reconnectSpy).toHaveBeenCalledWith(1);
    });

    it('emits disconnected event on close after connected', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      const disconnectedSpy = vi.fn();
      conn.on('disconnected', disconnectedSpy);

      mockWsInstance.emit('close', 1006, Buffer.from('abnormal'));

      expect(disconnectedSpy).toHaveBeenCalledWith(1006, 'abnormal');
    });
  });

  // =========================================================================
  // Heartbeat
  // =========================================================================

  describe('heartbeat', () => {
    it('starts heartbeat after successful connection', async () => {
      const conn = new DelegateConnection(defaultOptions({ heartbeatInterval: 5000 }));
      await connectAndAuth(conn);

      expect((conn as any).heartbeatTimer).not.toBeNull();
    });

    it('sends ping at heartbeat interval', async () => {
      const conn = new DelegateConnection(defaultOptions({ heartbeatInterval: 5000 }));
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      // DEL-4: pongReceived starts as true (set in startHeartbeat),
      // so first tick will send ws.ping() + app-level ping
      vi.advanceTimersByTime(5000);

      // DEL-4: ws.ping() is called first (WS-level), then send() for app-level ping
      expect(mockWsInstance.ping).toHaveBeenCalled();
      expect(mockWsInstance.send).toHaveBeenCalled();
      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('ping');
      expect(sent.timestamp).toBeDefined();
    });

    it('stops heartbeat on disconnect', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      expect((conn as any).heartbeatTimer).not.toBeNull();
      conn.disconnect();
      expect((conn as any).heartbeatTimer).toBeNull();
    });
  });

  // =========================================================================
  // Message handling through the full doConnect message listener
  // =========================================================================

  describe('message handling via WebSocket listener', () => {
    it('handles invalid JSON gracefully', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      // Should not throw
      expect(() => {
        mockWsInstance.emit('message', Buffer.from('not valid json {{{'));
      }).not.toThrow();
    });

    it('routes RC frames to handleReliableFrame when isMcpl', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      const spy = vi.spyOn(conn as any, 'handleReliableFrame');

      // Emit a RC-framed message
      mockWsInstance.emit(
        'message',
        Buffer.from(JSON.stringify({ seq: 1, ack: 0, payload: { type: 'mcpl/test' } })),
      );

      expect(spy).toHaveBeenCalledWith({ seq: 1, ack: 0, payload: { type: 'mcpl/test' } });
    });

    it('routes non-RC messages to handleMessage when isMcpl', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any)._isMcpl = true;
      const spy = vi.spyOn(conn as any, 'handleMessage');

      // Emit a legacy message (no seq field)
      const msg = { type: 'pong', timestamp: 123 };
      mockWsInstance.emit('message', Buffer.from(JSON.stringify(msg)));

      expect(spy).toHaveBeenCalledWith(msg);
    });
  });

  // =========================================================================
  // MCPL send methods (format verification)
  // =========================================================================

  describe('MCPL send methods', () => {
    it('sendBeforeInferenceResponse sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendBeforeInferenceResponse('req-1', [
        { serverId: 's1', position: 'system', content: 'context data' },
      ]);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/beforeInference_response');
      expect(sent.requestId).toBe('req-1');
      expect(sent.injections).toHaveLength(1);
      expect(sent.injections[0].position).toBe('system');
    });

    it('sendPushEvent includes timestamp', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendPushEvent({
        id: 'e1',
        source: 'webhook',
        conversationId: 'c1',
        eventType: 'update',
        payload: {},
        systemMessage: 'An update occurred',
        idempotencyKey: 'key-1',
      });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/push_event');
      expect(sent.timestamp).toBeDefined();
    });

    it('sendInferenceRequest sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendInferenceRequest({
        requestId: 'r1',
        serverId: 's1',
        conversationId: 'c1',
        userMessage: 'Hello',
      });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/inference_request');
      expect(sent.requestId).toBe('r1');
      expect(sent.userMessage).toBe('Hello');
    });

    it('sendScopeChangeRequest sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendScopeChangeRequest({
        requestId: 'r1',
        serverId: 's1',
        conversationId: 'c1',
        url: 'http://server.com',
        serverName: 'MyServer',
        requestedCapabilities: ['context_hooks'],
        reason: 'Need context hooks',
      });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/scope_change_request');
      expect(sent.url).toBe('http://server.com');
    });

    it('sendConnectServerResult sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendConnectServerResult({
        requestId: 'r1',
        url: 'http://server.com',
        success: true,
        serverId: 's1',
        tools: [{ name: 'tool1', description: 'desc', inputSchema: {} }],
      });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/connect_server_result');
      expect(sent.success).toBe(true);
    });

    it('sendScopeElevateRequest sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendScopeElevateRequest({
        requestId: 'r1',
        delegateId: 'd1',
        serverId: 's1',
        conversationId: 'c1',
        featureSet: 'fs1',
        label: 'Elevate label',
        requestedCapabilities: ['push_events'],
        reason: 'Need push events',
      });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/scope_elevate_request');
      expect(sent.featureSet).toBe('fs1');
    });

    it('sendFeatureSetsChanged sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      const featureSets = {
        server1: { contextHooks: true, pushEvents: false, inferenceRequests: false, toolManagement: false },
      };
      conn.sendFeatureSetsChanged(featureSets);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/featureSets_changed');
      expect(sent.featureSets).toEqual(featureSets);
    });

    it('sendStateSet sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendStateSet('r1', 'c1', { counter: 42 });

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/state_set');
      expect(sent.requestId).toBe('r1');
      expect(sent.conversationId).toBe('c1');
      expect(sent.state).toEqual({ counter: 42 });
    });

    it('sendStatePatch sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      const patch = [{ op: 'replace', path: '/counter', value: 43 }];
      conn.sendStatePatch('r1', 'c1', patch);

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/state_patch');
      expect(sent.patch).toEqual(patch);
    });

    it('sendStateRollback sends correct format without checkpointId', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendStateRollback('r1', 'c1');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/state_rollback');
      expect(sent).not.toHaveProperty('checkpointId');
    });

    it('sendStateRollback includes checkpointId when provided', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendStateRollback('r1', 'c1', 'cp-42');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.checkpointId).toBe('cp-42');
    });

    it('sendCheckpointList sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendCheckpointList('r1', 'c1');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/checkpoint_list');
      expect(sent.requestId).toBe('r1');
      expect(sent.conversationId).toBe('c1');
    });

    it('sendStateGet sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendStateGet('r1', 'c1');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/state_get');
      expect(sent.requestId).toBe('r1');
    });

    it('sendModelInfoRequest sends correct format', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);
      mockWsInstance.send.mockClear();

      conn.sendModelInfoRequest('r1');

      const sent = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(sent.type).toBe('mcpl/model_info_request');
      expect(sent.requestId).toBe('r1');
    });
  });

  // =========================================================================
  // cleanup (private)
  // =========================================================================

  describe('cleanup()', () => {
    it('removes all listeners from WebSocket', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      const ws = (conn as any).ws;
      const removeAllSpy = vi.spyOn(ws, 'removeAllListeners');

      (conn as any).cleanup();

      expect(removeAllSpy).toHaveBeenCalled();
    });

    it('closes WebSocket if open', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      mockWsInstance.readyState = 1; // OPEN
      (conn as any).cleanup();

      expect(mockWsInstance.close).toHaveBeenCalled();
    });

    it('closes WebSocket if connecting', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      mockWsInstance.readyState = 0; // CONNECTING
      (conn as any).cleanup();

      expect(mockWsInstance.close).toHaveBeenCalled();
    });

    it('does not close WebSocket if already closed', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      mockWsInstance.close.mockClear();
      mockWsInstance.readyState = 3; // CLOSED
      (conn as any).cleanup();

      expect(mockWsInstance.close).not.toHaveBeenCalled();
    });

    it('nullifies ws reference', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectAndAuth(conn);

      (conn as any).cleanup();
      expect((conn as any).ws).toBeNull();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles multiple sequential connect/disconnect cycles', async () => {
      const conn = new DelegateConnection(defaultOptions());

      // First cycle
      await connectAndAuth(conn);
      expect(conn.isConnected).toBe(true);
      conn.disconnect();
      expect(conn.currentState).toBe('disconnected');

      // Second cycle
      await connectAndAuth(conn);
      expect(conn.isConnected).toBe(true);
      conn.disconnect();
      expect(conn.currentState).toBe('disconnected');
    });

    it('RC frames deliver partial gap fills correctly', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.spyOn(conn as any, 'handleMcplMessage');

      // Receive 3, 5 (out of order, gap at 1, 2, 4)
      (conn as any).handleReliableFrame({ seq: 3, ack: 0, payload: { type: 'mcpl/msg3' } });
      (conn as any).handleReliableFrame({ seq: 5, ack: 0, payload: { type: 'mcpl/msg5' } });

      expect(spy).not.toHaveBeenCalled();

      // Fill seq 1 only — delivers 1, but 2 is still missing
      (conn as any).handleReliableFrame({ seq: 1, ack: 0, payload: { type: 'mcpl/msg1' } });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0].type).toBe('mcpl/msg1');
      expect((conn as any).rcInSeq).toBe(1);

      // Fill seq 2 — delivers 2, 3 (drains), but 4 missing so 5 stays buffered
      (conn as any).handleReliableFrame({ seq: 2, ack: 0, payload: { type: 'mcpl/msg2' } });

      expect(spy).toHaveBeenCalledTimes(3); // msg2, msg3
      expect((conn as any).rcInSeq).toBe(3);

      // Fill seq 4 — delivers 4, 5
      (conn as any).handleReliableFrame({ seq: 4, ack: 0, payload: { type: 'mcpl/msg4' } });

      expect(spy).toHaveBeenCalledTimes(5);
      expect((conn as any).rcInSeq).toBe(5);
      expect((conn as any).rcPending.size).toBe(0);
    });

    it('EventEmitter inheritance works (on/emit)', () => {
      const conn = new DelegateConnection(defaultOptions());
      const spy = vi.fn();
      conn.on('custom_event', spy);
      conn.emit('custom_event', 'data');
      expect(spy).toHaveBeenCalledWith('data');
    });
  });
});
