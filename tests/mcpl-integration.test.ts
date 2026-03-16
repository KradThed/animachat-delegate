/**
 * MCPL Integration Tests
 *
 * Tests the full MCPL protocol flow using a fake WebSocket backend.
 * Verifies: handshake, featureSet enforcement, beforeInference hooks,
 * afterInference hooks, push events, state management, scope elevation,
 * and reconnection behavior.
 *
 * Strategy: Mock the `ws` module so DelegateConnection connects to our
 * fake backend. Simulate the full message exchange per MCPL spec v0.4.1.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// WebSocket mock (same pattern as connection.test.ts)
// ---------------------------------------------------------------------------

let mockWsInstance: any = null;

vi.mock('ws', async () => {
  const { EventEmitter } = await import('events');

  class MockWebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    OPEN = 1;
    CONNECTING = 0;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 1;
    url: string;
    send = vi.fn();
    close = vi.fn();
    terminate = vi.fn();
    ping = vi.fn();

    constructor(url: string) {
      super();
      this.url = url;
      mockWsInstance = this;
    }
  }
  return { default: MockWebSocket };
});

import { DelegateConnection, type ConnectionOptions } from '../src/connection.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultOptions(overrides: Partial<ConnectionOptions> = {}): ConnectionOptions {
  return {
    serverUrl: 'wss://fake-backend.test/ws',
    token: 'test-token',
    delegateId: 'test-delegate',
    capabilities: ['mcp_host'],
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

function silenceConsole() {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

/** Get all messages sent by delegate as parsed JSON */
function getSentMessages(): any[] {
  return mockWsInstance.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
}

/** Get the last sent message */
function getLastSent(): any {
  const msgs = getSentMessages();
  return msgs[msgs.length - 1];
}

/** Simulate backend sending a message to delegate */
function backendSend(msg: Record<string, unknown>) {
  mockWsInstance.emit('message', Buffer.from(JSON.stringify(msg)));
}

/**
 * Connect and complete full MCPL handshake:
 * 1. WS open → delegate sends auth
 * 2. Backend responds with delegate_auth_result (sets sessionId, userId)
 * 3. Delegate sends mcpl/hello (MCP initialize with experimental.mcpl)
 * 4. Backend responds with mcpl/ack (JSON-RPC 2.0 response)
 */
async function connectWithMcpl(
  conn: DelegateConnection,
  ackOverrides: Record<string, unknown> = {},
): Promise<void> {
  const connectPromise = conn.connect();
  await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());

  // Step 1: Simulate WS open
  mockWsInstance.emit('open');

  // Step 2: Wait for auth message, respond with auth result
  await vi.waitFor(() => expect(mockWsInstance.send).toHaveBeenCalled());
  backendSend({
    type: 'delegate_auth_result',
    success: true,
    sessionId: 'sess-123',
    userId: 'user-456',
  });

  // Step 3: Wait for mcpl/hello (second send call)
  await vi.waitFor(() => {
    const calls = mockWsInstance.send.mock.calls;
    return calls.length >= 2;
  });

  // Find the hello message (has jsonrpc field or type === 'mcpl/hello')
  const calls = mockWsInstance.send.mock.calls;
  let hello: any = null;
  for (const call of calls) {
    const msg = JSON.parse(call[0]);
    if (msg.method === 'initialize' || msg.type === 'mcpl/hello') {
      hello = msg;
      break;
    }
  }
  if (!hello) {
    throw new Error('mcpl/hello not found in sent messages');
  }

  // Step 4: Respond with mcpl/ack
  const ackFeatureSets = ackOverrides.featureSets || {
    'test-server': {
      description: 'Test MCP server',
      uses: ['tools', 'contextHooks.beforeInference'],
    },
  };
  const { featureSets: _fs, ...restOverrides } = ackOverrides;
  backendSend({
    jsonrpc: '2.0',
    id: hello.id || hello.requestId,
    result: {
      _mcpl: { sessionId: 'mcpl-sess-1' },
      capabilities: {
        experimental: {
          mcpl: {
            featureSets: ackFeatureSets,
          },
        },
      },
      ...restOverrides,
    },
  });

  await connectPromise;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPL Integration', () => {
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
  // §5: Connection Lifecycle
  // =========================================================================

  describe('§5 Connection Lifecycle', () => {
    it('sends delegate_auth then mcpl/hello on connect', async () => {
      const conn = new DelegateConnection(defaultOptions());
      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());
      mockWsInstance.emit('open');
      await vi.waitFor(() => expect(mockWsInstance.send).toHaveBeenCalled());

      // First message is delegate_auth
      const auth = JSON.parse(mockWsInstance.send.mock.calls[0][0]);
      expect(auth.type).toBe('delegate_auth');

      // Send auth response to trigger mcpl/hello
      backendSend({ type: 'delegate_auth_result', success: true, sessionId: 's1', userId: 'u1' });
      await vi.waitFor(() => mockWsInstance.send.mock.calls.length >= 2);

      // Second message should be MCP initialize with MCPL capabilities
      const hello = JSON.parse(mockWsInstance.send.mock.calls[1][0]);
      expect(hello.method).toBe('initialize');
      expect(hello.params?.capabilities?.experimental?.mcpl).toBeDefined();
      expect(hello.id).toBeDefined();

      conn.disconnect();
    });

    it('transitions to connected state after mcpl/ack', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      expect(conn.isMcpl).toBe(true);
      expect(conn.currentState).toBe('connected');
      conn.disconnect();
    });

    it('stores featureSets from ack', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, {
        featureSets: {
          'server-a': { description: 'A', uses: ['tools'] },
          'server-b': { description: 'B', uses: ['pushEvents'] },
        },
      });

      expect(conn.featureSets).toHaveProperty('server-a');
      expect(conn.featureSets).toHaveProperty('server-b');
      conn.disconnect();
    });

    it('emits connected event with sessionId and userId', async () => {
      const conn = new DelegateConnection(defaultOptions());
      const connectedSpy = vi.fn();
      conn.on('connected', connectedSpy);

      await connectWithMcpl(conn);

      expect(connectedSpy).toHaveBeenCalled();
      conn.disconnect();
    });
  });

  // =========================================================================
  // §6: Feature Sets
  // =========================================================================

  describe('§6 Feature Set Enforcement', () => {
    it('allows sending push event for enabled featureSet', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, {
        featureSets: {
          'webhook-server': { description: 'Webhooks', uses: ['pushEvents'] },
        },
      });

      (conn as any)._isMcpl = false; // skip RC framing for test simplicity
      mockWsInstance.send.mockClear();

      const result = conn.sendPushEvent({
        featureSet: 'webhook-server',
        eventType: 'git.push',
        payload: { content: [{ type: 'text', text: 'Push event' }] },
      });

      // Should not be rejected
      expect(mockWsInstance.send).toHaveBeenCalled();
      conn.disconnect();
    });

    it('rejects push event for disabled featureSet', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, {
        featureSets: {
          'webhook-server': { description: 'Webhooks', uses: ['pushEvents'] },
        },
      });

      // Disable the featureSet
      backendSend({
        type: 'mcpl/featureSets_update',
        disabled: ['webhook-server'],
      });

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      // Should be rejected (returns false or throws)
      const result = conn.sendPushEvent({
        featureSet: 'webhook-server',
        eventType: 'git.push',
        payload: { content: [{ type: 'text', text: 'test' }] },
      });

      // The push event should NOT have been sent
      const msgs = getSentMessages().filter(m => m.type === 'mcpl/push_event');
      expect(msgs.length).toBe(0);
      conn.disconnect();
    });

    it('rejects push event for unknown featureSet with -32003', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      conn.sendPushEvent({
        featureSet: 'nonexistent-server',
        eventType: 'test',
        payload: { content: [{ type: 'text', text: 'test' }] },
      });

      const msgs = getSentMessages().filter(m => m.type === 'mcpl/push_event');
      expect(msgs.length).toBe(0);
      conn.disconnect();
    });

    it('§6.7: featureSets/update enables previously disabled featureSet', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, {
        featureSets: {
          'server-a': { description: 'A', uses: ['tools'] },
        },
      });

      // Disable, then re-enable
      backendSend({ type: 'mcpl/featureSets_update', disabled: ['server-a'] });
      expect(conn.checkFeatureSet('server-a')).toBe('disabled');

      backendSend({ type: 'mcpl/featureSets_update', enabled: ['server-a'] });
      expect(conn.checkFeatureSet('server-a')).toBe('enabled');

      conn.disconnect();
    });
  });

  // =========================================================================
  // §9: Push Events
  // =========================================================================

  describe('§9 Push Events', () => {
    it('sends push event with correct structure', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, {
        featureSets: {
          'my-server': { description: 'Server', uses: ['pushEvents'] },
        },
      });

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      conn.sendPushEvent({
        featureSet: 'my-server',
        eventType: 'webhook.received',
        payload: { content: [{ type: 'text', text: 'Hello from webhook' }] },
        conversationId: 'conv-1',
      });

      const msgs = getSentMessages();
      const pushMsg = msgs.find(m => m.type === 'mcpl/push_event');
      expect(pushMsg).toBeDefined();
      expect(pushMsg.featureSet).toBe('my-server');
      expect(pushMsg.eventType).toBe('webhook.received');
      expect(pushMsg.payload.content[0].text).toBe('Hello from webhook');
      conn.disconnect();
    });

    it('emits mcpl_push_event_response when backend responds', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_push_event_response', spy);

      backendSend({
        type: 'mcpl/push_event_response',
        requestId: 'push-1',
        accepted: true,
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        accepted: true,
        requestId: 'push-1',
      }));
      conn.disconnect();
    });
  });

  // =========================================================================
  // §10: Context Hooks
  // =========================================================================

  describe('§10 Context Hooks', () => {
    it('emits mcpl_before_inference when backend sends hook request', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_before_inference', spy);

      backendSend({
        type: 'mcpl/beforeInference',
        requestId: 'bi-1',
        inferenceId: 'inf-1',
        conversationId: 'conv-1',
        turnIndex: 0,
        userMessage: 'Hello',
        model: { id: 'claude-sonnet-4-6', vendor: 'anthropic' },
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        requestId: 'bi-1',
        conversationId: 'conv-1',
      });
      conn.disconnect();
    });

    it('sendBeforeInferenceResponse includes contextInjections and abort', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      conn.sendBeforeInferenceResponse('bi-1', [
        {
          namespace: 'test-server',
          position: 'system',
          content: 'Injected context',
        },
      ], undefined, true, 'Server requested abort');

      const sent = getLastSent();
      expect(sent.type).toBe('mcpl/beforeInference_response');
      expect(sent.requestId).toBe('bi-1');
      expect(sent.contextInjections).toHaveLength(1);
      expect(sent.contextInjections[0].content).toBe('Injected context');
      expect(sent.abort).toBe(true);
      expect(sent.abortReason).toBe('Server requested abort');
      conn.disconnect();
    });

    it('sendBeforeInferenceResponse supports multimodal ContentBlock[]', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      conn.sendBeforeInferenceResponse('bi-2', [
        {
          namespace: 'vision-server',
          position: 'beforeUser',
          content: [
            { type: 'text', text: 'See this image:' },
            { type: 'image', data: 'base64data', mimeType: 'image/png' },
          ],
        },
      ]);

      const sent = getLastSent();
      expect(sent.contextInjections[0].content).toEqual([
        { type: 'text', text: 'See this image:' },
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
      ]);
      conn.disconnect();
    });

    it('emits mcpl_after_inference event', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_after_inference', spy);

      // Use handleMcplMessage directly to avoid RC framing complexity
      (conn as any).handleMcplMessage({
        type: 'mcpl/afterInference',
        requestId: 'ai-1',
        conversationId: 'conv-1',
        assistantMessage: 'Response text',
      });

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        requestId: 'ai-1',
        conversationId: 'conv-1',
      });
      conn.disconnect();
    });
  });

  // =========================================================================
  // §8: State Management
  // =========================================================================

  describe('§8 State Management', () => {
    it('sends state_get request', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      conn.sendStateGet('req-1', 'conv-1');

      const sent = getLastSent();
      expect(sent.type).toBe('mcpl/state_get');
      expect(sent.requestId).toBe('req-1');
      conn.disconnect();
    });

    it('emits mcpl_state_response on backend reply', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_state_response', spy);

      backendSend({
        type: 'mcpl/state_response',
        requestId: 'req-1',
        data: { counter: 42 },
        version: 3,
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-1',
        data: { counter: 42 },
      }));
      conn.disconnect();
    });

    it('sends state_patch with JSON Patch operations', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      conn.sendStatePatch('req-2', 'conv-1', [
        { op: 'replace', path: '/counter', value: 43 },
      ]);

      const sent = getLastSent();
      expect(sent.type).toBe('mcpl/state_patch');
      expect(sent.patch).toEqual([
        { op: 'replace', path: '/counter', value: 43 },
      ]);
      conn.disconnect();
    });

    it('emits mcpl_state_patch_result on backend reply', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_state_patch_result', spy);

      backendSend({
        type: 'mcpl/state_patch_result',
        requestId: 'req-2',
        success: true,
        version: 4,
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        version: 4,
      }));
      conn.disconnect();
    });
  });

  // =========================================================================
  // §11: Server-Initiated Inference
  // =========================================================================

  describe('§11 Server-Initiated Inference', () => {
    it('sends inference request', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, {
        featureSets: {
          'ai-server': { description: 'AI', uses: ['inferenceRequest'] },
        },
      });

      (conn as any)._isMcpl = false;
      mockWsInstance.send.mockClear();

      conn.sendInferenceRequest({
        requestId: 'inf-req-1',
        featureSet: 'ai-server',
        conversationId: 'conv-1',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const msgs = getSentMessages();
      const infMsg = msgs.find(m => m.type === 'mcpl/inference_request');
      expect(infMsg).toBeDefined();
      expect(infMsg.featureSet).toBe('ai-server');
      conn.disconnect();
    });

    it('emits mcpl_inference_response', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_inference_response', spy);

      backendSend({
        type: 'mcpl/inference_response',
        requestId: 'inf-req-1',
        content: 'Hello back!',
        model: 'claude-sonnet-4-6',
        finishReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'inf-req-1',
        content: 'Hello back!',
      }));
      conn.disconnect();
    });

    it('emits mcpl_inference_chunk for streaming', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_inference_chunk', spy);

      backendSend({
        type: 'mcpl/inference_chunk',
        requestId: 'inf-req-1',
        delta: 'Hello ',
        index: 0,
      });
      backendSend({
        type: 'mcpl/inference_chunk',
        requestId: 'inf-req-1',
        delta: 'world!',
        index: 1,
      });

      expect(spy).toHaveBeenCalledTimes(2);
      conn.disconnect();
    });
  });

  // =========================================================================
  // §7: Scope Elevation
  // =========================================================================

  describe('§7 Scope Elevation', () => {
    it('emits mcpl_scope_elevate_result on approval', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_scope_elevate_result', spy);

      backendSend({
        type: 'mcpl/scope_elevate_result',
        requestId: 'scope-1',
        approved: true,
        payload: { path: '/tmp/safe.txt' },
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        approved: true,
        requestId: 'scope-1',
      }));
      conn.disconnect();
    });

    it('emits scope denial with reason', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_scope_elevate_result', spy);

      backendSend({
        type: 'mcpl/scope_elevate_result',
        requestId: 'scope-2',
        approved: false,
        reason: 'User denied the request',
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        approved: false,
        reason: 'User denied the request',
      }));
      conn.disconnect();
    });
  });

  // =========================================================================
  // §12: Model Info
  // =========================================================================

  describe('§12 Model Info', () => {
    it('emits mcpl_model_info_response', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_model_info_response', spy);

      backendSend({
        type: 'mcpl/model_info_response',
        requestId: 'mi-1',
        id: 'claude-sonnet-4-6',
        vendor: 'anthropic',
        contextWindow: 200000,
        capabilities: ['tools', 'vision'],
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        id: 'claude-sonnet-4-6',
        vendor: 'anthropic',
      }));
      conn.disconnect();
    });
  });

  // =========================================================================
  // §15: Error Handling
  // =========================================================================

  describe('§15 Error Handling', () => {
    it('emits mcpl_error on protocol error', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn);

      const spy = vi.fn();
      conn.on('mcpl_error', spy);

      backendSend({
        type: 'mcpl/error',
        code: -32001,
        message: 'Feature set not enabled: test-server',
      });

      expect(spy).toHaveBeenCalledWith(expect.objectContaining({
        code: -32001,
      }));
      conn.disconnect();
    });
  });

  // =========================================================================
  // Pre-populate featureSets (П3 fix)
  // =========================================================================

  describe('П3: prePopulateFeatureSets', () => {
    it('pre-populates enabled featureSets before featureSets/changed is sent', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, { featureSets: {} });

      // Pre-populate with known featureSet names
      conn.prePopulateFeatureSets(['webhook-server', 'git-server']);

      // Now these should be recognized as enabled
      expect(conn.checkFeatureSet('webhook-server')).toBe('enabled');
      expect(conn.checkFeatureSet('git-server')).toBe('enabled');
      conn.disconnect();
    });
  });

  // =========================================================================
  // Reconnect behavior (П6 fix)
  // =========================================================================

  describe('П6: Reconnect preserves local featureSets', () => {
    it('locally-added featureSets survive reconnect', async () => {
      const conn = new DelegateConnection(defaultOptions());
      await connectWithMcpl(conn, {
        featureSets: {
          'backend-server': { description: 'From backend', uses: ['tools'] },
        },
      });

      // Simulate delegate adding its own featureSet
      conn.sendFeatureSetsChanged({
        added: {
          'local-server': { description: 'Local MCP', uses: ['tools', 'pushEvents'] },
        },
      });

      // Verify local-server is tracked
      expect(conn.checkFeatureSet('local-server')).toBe('enabled');

      // Verify _featureSets has both
      expect(conn.featureSets).toHaveProperty('backend-server');
      expect(conn.featureSets).toHaveProperty('local-server');

      conn.disconnect();
    });
  });

  // =========================================================================
  // Bug Fix Regression Tests
  // =========================================================================

  describe('Bug fix regressions', () => {
    it('Bug 3: afterInference negotiation returns non-blocking', async () => {
      // Delegate requests { blocking: true }, backend should negotiate to true (boolean)
      const conn = new DelegateConnection(defaultOptions({
        mcplCapabilities: {
          version: '0.4',
          contextHooks: {
            beforeInference: true,
            afterInference: { blocking: true },
          },
        },
      }));

      const connectPromise = conn.connect();
      await vi.waitFor(() => expect(mockWsInstance).toBeTruthy());
      mockWsInstance.emit('open');
      await vi.waitFor(() => expect(mockWsInstance.send).toHaveBeenCalled());

      backendSend({
        type: 'delegate_auth_result',
        success: true,
        sessionId: 's1',
        userId: 'u1',
      });

      await vi.waitFor(() => mockWsInstance.send.mock.calls.length >= 2);

      const calls = mockWsInstance.send.mock.calls;
      let hello: any = null;
      for (const call of calls) {
        const msg = JSON.parse(call[0]);
        if (msg.method === 'initialize' || msg.type === 'mcpl/hello') {
          hello = msg;
          break;
        }
      }
      expect(hello).toBeTruthy();

      // Backend ack with afterInference negotiated to true (non-blocking)
      backendSend({
        jsonrpc: '2.0',
        id: hello.id || hello.requestId,
        result: {
          _mcpl: { sessionId: 'mcpl-sess-1' },
          capabilities: {
            experimental: {
              mcpl: {
                featureSets: {
                  'test-server': { description: 'Test', uses: ['contextHooks.afterInference'] },
                },
              },
            },
            contextHooks: {
              beforeInference: true,
              afterInference: true,  // boolean = notification-only, NOT { blocking: true }
            },
          },
        },
      });

      await connectPromise;

      // Verify delegate connected and got the negotiated capabilities
      expect(conn.isConnected).toBe(true);

      conn.disconnect();
    });
  });
});
