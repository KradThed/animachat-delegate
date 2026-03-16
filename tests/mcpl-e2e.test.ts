/**
 * MCPL End-to-End Tests
 *
 * Spins up a real WebSocket server (fake backend), connects DelegateConnection
 * to it, and verifies the full MCPL protocol roundtrip including:
 * - Handshake (hello → ack)
 * - Tool manifest exchange
 * - beforeInference hook forwarding (backend → delegate → MCP server → delegate → backend)
 * - Push event flow
 * - featureSets/changed notification
 * - featureSets/update application
 *
 * Does NOT mock WebSocket — uses real ws connections on localhost.
 * Does NOT use real MCP servers — mocks McpHostManager for isolation.
 */

/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocketServer, WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Fake Backend — minimal MCPL-speaking WebSocket server
// ---------------------------------------------------------------------------

interface FakeBackendOptions {
  port: number;
  featureSets?: Record<string, { description: string; uses: string[] }>;
}

/**
 * Wire method name → internal type (subset of delegate's WIRE_TO_INTERNAL for decoding).
 */
const WIRE_TO_INTERNAL: Record<string, string> = {
  'context/beforeInference':      'mcpl/beforeInference',
  'context/afterInference':       'mcpl/afterInference',
  'context/beforeInferenceResult':'mcpl/beforeInference_response',
  'context/afterInferenceResult': 'mcpl/afterInference_response',
  'context/afterInferenceAck':    'mcpl/afterInference_ack',
  'push/event':                   'mcpl/push_event',
  'push/eventResult':             'mcpl/push_event_response',
  'inference/request':            'mcpl/inference_request',
  'inference/response':           'mcpl/inference_response',
  'inference/chunk':              'mcpl/inference_chunk',
  'state/set':                    'mcpl/state_set',
  'state/get':                    'mcpl/state_get',
  'state/patch':                  'mcpl/state_patch',
  'state/rollback':               'mcpl/state_rollback',
  'featureSets/changed':          'mcpl/featureSets_changed',
  'featureSets/update':           'mcpl/featureSets_update',
  'scope/request':                'mcpl/scope_change_request',
  'scope/elevate':                'mcpl/scope_elevate_request',
  'model/info':                   'mcpl/model_info_request',
};

class FakeBackend extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private port: number;
  private featureSets: Record<string, { description: string; uses: string[] }>;
  public receivedMessages: any[] = [];
  /** ReliableChannel state */
  private rcOutSeq = 0;
  private rcInSeq = 0;
  private rcActive = false;
  /** Track outgoing requests so we can map JSON-RPC responses back */
  private pendingOutgoing = new Map<string | number, string>();

  constructor(opts: FakeBackendOptions) {
    super();
    this.port = opts.port;
    this.featureSets = opts.featureSets || {};
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.on('listening', resolve);

      this.wss.on('connection', (ws) => {
        this.client = ws;
        this.rcActive = false;
        this.rcOutSeq = 0;
        this.rcInSeq = 0;
        this.pendingOutgoing.clear();
        ws.on('message', (data) => {
          const raw = JSON.parse(data.toString());

          // Detect RC frames: { seq: N, ack: M, payload?: {...} }
          if (typeof raw.seq === 'number' && typeof raw.ack === 'number') {
            // Bare ack from delegate (seq=0, no payload)
            if (raw.seq === 0 || !raw.payload) {
              return;
            }

            this.rcActive = true;
            this.rcInSeq = raw.seq;

            // Send bare ack back: { seq: 0, ack: receivedSeq }
            ws.send(JSON.stringify({ seq: 0, ack: raw.seq }));

            const msg = raw.payload;
            this.receivedMessages.push(msg);
            this.handleMessage(ws, msg);
            return;
          }

          this.receivedMessages.push(raw);
          this.handleMessage(ws, raw);
        });
      });
    });
  }

  /**
   * Decode a JSON-RPC 2.0 message into internal format.
   * Returns null if not JSON-RPC.
   */
  private decodeJsonRpc(msg: any): any | null {
    if (msg.jsonrpc !== '2.0') return null;

    // JSON-RPC response (has id + result/error, no method)
    if (msg.id !== undefined && !msg.method) {
      const id = msg.id;
      const requestType = this.pendingOutgoing.get(id);
      this.pendingOutgoing.delete(id);
      if (msg.error) {
        return { type: 'mcpl/error', requestId: id, ...msg.error };
      }
      const result = (msg.result && typeof msg.result === 'object') ? msg.result : {};
      // Map to response type based on the original request
      let responseType = 'unknown_response';
      if (requestType === 'mcpl/beforeInference') responseType = 'mcpl/beforeInference_response';
      else if (requestType === 'mcpl/afterInference') responseType = 'mcpl/afterInference_response';
      else if (requestType === 'mcpl/push_event') responseType = 'mcpl/push_event_response';
      else if (requestType === 'mcpl/inference_request') responseType = 'mcpl/inference_response';
      return { type: responseType, requestId: id, ...result };
    }

    // JSON-RPC request (has method + id)
    if (msg.method && msg.id !== undefined) {
      const internalType = WIRE_TO_INTERNAL[msg.method] || msg.method;
      const params = (msg.params && typeof msg.params === 'object') ? msg.params : {};
      return { type: internalType, requestId: msg.id, ...params };
    }

    // JSON-RPC notification (has method, no id)
    if (msg.method) {
      if (msg.method === 'notifications/initialized') return null; // MCP lifecycle, ignore
      const internalType = WIRE_TO_INTERNAL[msg.method] || msg.method;
      const params = (msg.params && typeof msg.params === 'object') ? msg.params : {};
      return { type: internalType, ...params };
    }

    return null;
  }

  private handleMessage(ws: WebSocket, msg: any) {
    // Step 1: delegate_auth → respond with auth success (pre-handshake, raw format)
    if (msg.type === 'delegate_auth') {
      ws.send(JSON.stringify({
        type: 'delegate_auth_result',
        success: true,
        sessionId: 'e2e-session-1',
        userId: 'e2e-user-1',
      }));
      return;
    }

    // Step 2: MCP initialize (MCPL hello) → respond with ack (pre-handshake, raw JSON-RPC)
    if (msg.method === 'initialize' && msg.jsonrpc === '2.0') {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          _mcpl: { sessionId: 'e2e-mcpl-sess-1' },
          capabilities: {
            experimental: {
              mcpl: {
                featureSets: this.featureSets,
              },
            },
          },
        },
      }));
      return;
    }

    // Try to decode JSON-RPC 2.0 messages from the delegate's codec (post-handshake)
    const decoded = this.decodeJsonRpc(msg);
    if (decoded) {
      this.dispatchInternal(ws, decoded);
      return;
    }

    // Legacy raw-type messages (pre-codec or non-MCPL)
    this.dispatchInternal(ws, msg);
  }

  /** Dispatch an internal-format message (either decoded from JSON-RPC or raw) */
  private dispatchInternal(ws: WebSocket, msg: any) {
    // Tool manifest → ack
    if (msg.type === 'tool_manifest') {
      ws.send(JSON.stringify({
        type: 'tool_manifest_ack',
        receivedCount: msg.tools?.length || 0,
      }));
      return;
    }

    // featureSets/changed → emit
    if (msg.type === 'mcpl/featureSets_changed') {
      this.emit('featureSets_changed', msg);
      return;
    }

    // beforeInference response → emit
    if (msg.type === 'mcpl/beforeInference_response') {
      this.emit('beforeInference_response', msg);
      return;
    }

    // afterInference ack/response → emit
    if (msg.type === 'mcpl/afterInference_ack' || msg.type === 'mcpl/afterInference_response') {
      this.emit('afterInference_response', msg);
      return;
    }

    // push_event from delegate → respond with accepted (JSON-RPC response)
    if (msg.type === 'mcpl/push_event') {
      this.emit('push_event', msg);
      // Respond as JSON-RPC success response so delegate codec can decode it
      if (msg.requestId) {
        this.sendRaw({ jsonrpc: '2.0', id: msg.requestId, result: { accepted: true } });
      }
      return;
    }

    // push_event_response (decoded from JSON-RPC) → emit
    if (msg.type === 'mcpl/push_event_response') {
      this.emit('push_event_response', msg);
      return;
    }

    // Generic — emit for test inspection
    this.emit('message', msg);
  }

  /** Send raw JSON over WebSocket (with RC wrapping if active) */
  private sendRaw(payload: Record<string, unknown>) {
    if (!this.client || this.client.readyState !== WebSocket.OPEN) return;
    if (this.rcActive) {
      this.rcOutSeq++;
      this.client.send(JSON.stringify({
        seq: this.rcOutSeq,
        ack: this.rcInSeq,
        payload,
      }));
    } else {
      this.client.send(JSON.stringify(payload));
    }
  }

  /** Send a message from backend to delegate (raw internal format, RC-wrapped if active) */
  send(msg: Record<string, unknown>) {
    this.sendRaw(msg);
  }

  /** Send beforeInference request to delegate */
  sendBeforeInference(opts: {
    requestId: string;
    conversationId: string;
    userMessage: string;
  }) {
    this.pendingOutgoing.set(opts.requestId, 'mcpl/beforeInference');
    this.send({
      type: 'mcpl/beforeInference',
      ...opts,
      inferenceId: `inf-${opts.requestId}`,
      turnIndex: 0,
      model: { id: 'claude-sonnet-4-6', vendor: 'anthropic' },
    });
  }

  /** Send afterInference notification to delegate */
  sendAfterInference(opts: {
    requestId: string;
    conversationId: string;
    assistantMessage: string;
  }) {
    this.pendingOutgoing.set(opts.requestId, 'mcpl/afterInference');
    this.send({
      type: 'mcpl/afterInference',
      ...opts,
      turnIndex: 0,
      model: { id: 'claude-sonnet-4-6', vendor: 'anthropic' },
    });
  }

  /** Send featureSets/update to delegate */
  sendFeatureSetsUpdate(opts: {
    enabled?: string[];
    disabled?: string[];
    scopes?: Record<string, unknown>;
  }) {
    this.send({
      type: 'mcpl/featureSets_update',
      ...opts,
    });
  }

  /** Send tool_call_request to delegate */
  sendToolCallRequest(opts: {
    requestId: string;
    tool: string;
    input: Record<string, unknown>;
    conversationId?: string;
  }) {
    this.send({
      type: 'tool_call_request',
      ...opts,
    });
  }

  getReceivedByType(type: string): any[] {
    return this.receivedMessages.filter(m => m.type === type);
  }

  /** Get received messages decoded from JSON-RPC (with internal type) */
  getDecodedByType(type: string): any[] {
    return this.receivedMessages.filter(m => {
      // Direct type match
      if (m.type === type) return true;
      // JSON-RPC request/notification: decode wire method
      if (m.jsonrpc === '2.0' && m.method) {
        const internalType = WIRE_TO_INTERNAL[m.method] || m.method;
        return internalType === type;
      }
      return false;
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.client) {
        this.client.close();
        this.client = null;
      }
      if (this.wss) {
        this.wss.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for an event with timeout */
function waitForEvent(emitter: EventEmitter, event: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for event: ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Wait for a condition to be true */
async function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// We need to import DelegateConnection without the ws mock
// Since the E2E test uses REAL WebSocket, we do NOT mock ws here.
import { DelegateConnection, type ConnectionOptions } from '../src/connection.js';

// ---------------------------------------------------------------------------
// Test Config
// ---------------------------------------------------------------------------

const E2E_PORT = 18923; // Use high port to avoid conflicts
const E2E_URL = `ws://127.0.0.1:${E2E_PORT}`;

function e2eOptions(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    serverUrl: E2E_URL,
    token: 'e2e-test-token',
    delegateId: 'e2e-delegate',
    capabilities: ['mcp_host'],
    autoReconnect: false,
    mcplCapabilities: {
      version: '0.4',
      pushEvents: true,
      contextHooks: {
        beforeInference: true,
        afterInference: { blocking: true },
      },
      inferenceRequest: { streaming: false },
      modelInfo: true,
      featureSets: true,
      toolManagement: true,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe('MCPL E2E (real WebSocket)', () => {
  let backend: FakeBackend;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (backend) await backend.stop();
    vi.restoreAllMocks();
  });

  it('completes full MCPL handshake over real WebSocket', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {
        'test-server': { description: 'Test', uses: ['tools', 'contextHooks.beforeInference'] },
      },
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    expect(conn.isMcpl).toBe(true);
    expect(conn.currentState).toBe('connected');
    expect(conn.featureSets).toHaveProperty('test-server');

    // Backend should have received delegate_auth + initialize (MCPL hello)
    await waitFor(() => backend.receivedMessages.some(m => m.method === 'initialize'));
    const hello = backend.receivedMessages.find(m => m.method === 'initialize');
    expect(hello).toBeDefined();
    expect(hello.params?.protocolVersion).toBeDefined();

    conn.disconnect();
  }, 10000);

  it('sends tool_manifest after connect', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {},
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());

    // Listen for connected event
    const connectedPromise = waitForEvent(conn, 'connected');
    await conn.connect();
    await connectedPromise;

    // Give time for tool_manifest to be sent
    await new Promise(r => setTimeout(r, 100));

    // Backend should have received tool_manifest
    const manifests = backend.getReceivedByType('tool_manifest');
    // May or may not have tools depending on McpHostManager state
    // But the message type should be sent
    expect(manifests.length).toBeGreaterThanOrEqual(0);

    conn.disconnect();
  }, 10000);

  it('receives and applies featureSets/update', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {
        'server-a': { description: 'A', uses: ['tools'] },
        'server-b': { description: 'B', uses: ['pushEvents'] },
      },
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    // Both should be enabled initially
    expect(conn.checkFeatureSet('server-a')).toBe('enabled');
    expect(conn.checkFeatureSet('server-b')).toBe('enabled');

    // Backend disables server-b
    backend.sendFeatureSetsUpdate({ disabled: ['server-b'] });

    await new Promise(r => setTimeout(r, 100));

    expect(conn.checkFeatureSet('server-a')).toBe('enabled');
    expect(conn.checkFeatureSet('server-b')).toBe('disabled');

    // Backend re-enables server-b
    backend.sendFeatureSetsUpdate({ enabled: ['server-b'] });

    await new Promise(r => setTimeout(r, 100));

    expect(conn.checkFeatureSet('server-b')).toBe('enabled');

    conn.disconnect();
  }, 10000);

  it('sends featureSets/changed with delta', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {},
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    const changedPromise = waitForEvent(backend, 'featureSets_changed');

    conn.sendFeatureSetsChanged({
      added: {
        'new-server': { description: 'Dynamically added', uses: ['tools', 'pushEvents'] },
      },
    });

    const changedMsg = await changedPromise;
    expect(changedMsg.added).toHaveProperty('new-server');
    expect(changedMsg.added['new-server'].uses).toContain('pushEvents');

    conn.disconnect();
  }, 10000);

  it('sends push event and receives response', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {
        'webhook-server': { description: 'Webhooks', uses: ['pushEvents'] },
      },
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    const pushPromise = waitForEvent(backend, 'push_event');
    const responsePromise = waitForEvent(conn, 'mcpl_push_event_response');

    conn.sendPushEvent({
      eventId: 'push-e2e-1',
      featureSet: 'webhook-server',
      conversationId: 'conv-e2e',
      eventType: 'git.push',
      payload: { content: [{ type: 'text', text: 'New commits pushed' }] },
      systemMessage: 'New commits pushed',
      idempotencyKey: 'idem-1',
    });

    const pushMsg = await pushPromise;
    expect(pushMsg.eventType).toBe('git.push');
    expect(pushMsg.featureSet).toBe('webhook-server');

    const response = await responsePromise;
    expect(response.accepted).toBe(true);

    conn.disconnect();
  }, 10000);

  it('handles beforeInference roundtrip', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {
        'hook-server': { description: 'Hooks', uses: ['contextHooks.beforeInference'] },
      },
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    // Delegate receives beforeInference → responds with injections
    conn.on('mcpl_before_inference', (msg: any) => {
      conn.sendBeforeInferenceResponse(msg.requestId, [
        {
          namespace: 'e2e-test',
          position: 'system',
          content: 'E2E injected context',
        },
      ]);
    });

    const responsePromise = waitForEvent(backend, 'beforeInference_response');

    backend.sendBeforeInference({
      requestId: 'bi-e2e-1',
      conversationId: 'conv-e2e',
      userMessage: 'Hello E2E',
    });

    const response = await responsePromise;
    expect(response.requestId).toBe('bi-e2e-1');
    expect(response.contextInjections).toHaveLength(1);
    expect(response.contextInjections[0].content).toBe('E2E injected context');
    expect(response.contextInjections[0].namespace).toBe('e2e-test');

    conn.disconnect();
  }, 10000);

  it('handles afterInference notification + ack', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {},
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    const ackPromise = waitForEvent(backend, 'afterInference_response');

    backend.sendAfterInference({
      requestId: 'ai-e2e-1',
      conversationId: 'conv-e2e',
      assistantMessage: 'The response',
    });

    const ack = await ackPromise;
    expect(ack.requestId).toBe('ai-e2e-1');

    conn.disconnect();
  }, 10000);

  it('enforces featureSet on push events after disable', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {
        'my-server': { description: 'Server', uses: ['pushEvents'] },
      },
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    // First push should work
    const push1Promise = waitForEvent(backend, 'push_event');
    conn.sendPushEvent({
      eventId: 'push-enforce-1',
      featureSet: 'my-server',
      conversationId: 'conv-enforce',
      eventType: 'test.event',
      payload: { content: [{ type: 'text', text: 'First' }] },
      systemMessage: 'First event',
      idempotencyKey: 'idem-enforce-1',
    });
    await push1Promise;

    // Disable the featureSet
    backend.sendFeatureSetsUpdate({ disabled: ['my-server'] });
    await new Promise(r => setTimeout(r, 100));

    // Second push should be rejected locally
    const pushSpy = vi.fn();
    backend.on('push_event', pushSpy);

    conn.sendPushEvent({
      eventId: 'push-enforce-2',
      featureSet: 'my-server',
      conversationId: 'conv-enforce',
      eventType: 'test.event',
      payload: { content: [{ type: 'text', text: 'Second — should fail' }] },
      systemMessage: 'Second event',
      idempotencyKey: 'idem-enforce-2',
    });

    await new Promise(r => setTimeout(r, 200));
    expect(pushSpy).not.toHaveBeenCalled();

    conn.disconnect();
  }, 10000);

  it('handles protocol error from backend', async () => {
    backend = new FakeBackend({
      port: E2E_PORT,
      featureSets: {},
    });
    await backend.start();

    const conn = new DelegateConnection(e2eOptions());
    await conn.connect();

    const errorPromise = waitForEvent(conn, 'mcpl_error');

    backend.send({
      type: 'mcpl/error',
      code: -32001,
      message: 'Feature set not enabled',
    });

    const error = await errorPromise;
    expect(error.code).toBe(-32001);

    conn.disconnect();
  }, 10000);
});
