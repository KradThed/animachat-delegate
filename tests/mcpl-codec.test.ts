import { describe, it, expect, beforeEach, vi } from 'vitest';
import { McplCodec, type PendingRequestsState } from '../src/mcpl-codec.js';

// =============================================================================
// Helpers
// =============================================================================

function createCodec() {
  return new McplCodec();
}

// =============================================================================
// Tests: encode — internal → JSON-RPC 2.0
// =============================================================================

describe('McplCodec (delegate)', () => {
  let codec: McplCodec;

  beforeEach(() => {
    codec = createCodec();
  });

  // ---------------------------------------------------------------------------
  // encode: Response
  // ---------------------------------------------------------------------------

  describe('encode — Response', () => {
    it('encodes mcpl/beforeInference_response as JSON-RPC success response', () => {
      const wire = codec.encode({
        type: 'mcpl/beforeInference_response',
        requestId: 'req-1',
        injections: [{ position: 'system', content: 'hello' }],
      });

      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('req-1');
      expect(wire.result).toEqual({
        injections: [{ position: 'system', content: 'hello' }],
      });
      expect(wire).not.toHaveProperty('method');
    });

    it('strips type and requestId from result payload', () => {
      const wire = codec.encode({
        type: 'mcpl/afterInference_ack',
        requestId: 'req-2',
      });

      expect(wire.result).toEqual({});
    });

    it('uses null id when requestId is missing', () => {
      const wire = codec.encode({ type: 'mcpl/ack', sessionId: 'sess' });
      expect(wire.id).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // encode: Error
  // ---------------------------------------------------------------------------

  describe('encode — Error', () => {
    it('encodes mcpl/error as JSON-RPC error response', () => {
      const wire = codec.encode({
        type: 'mcpl/error',
        requestId: 'req-3',
        code: -32001,
        message: 'Capability disabled',
      });

      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('req-3');
      expect(wire.error).toEqual({
        code: -32001,
        message: 'Capability disabled',
      });
    });

    it('includes retryAfterMs in error data', () => {
      const wire = codec.encode({
        type: 'mcpl/error',
        requestId: 'req-4',
        code: -32004,
        message: 'Rate limited',
        retryAfterMs: 5000,
      });

      expect((wire.error as any).data).toEqual({ retryAfterMs: 5000 });
    });
  });

  // ---------------------------------------------------------------------------
  // encode: Notification
  // ---------------------------------------------------------------------------

  describe('encode — Notification', () => {
    it('encodes mcpl/featureSets_changed as JSON-RPC notification (no id)', () => {
      const wire = codec.encode({
        type: 'mcpl/featureSets_changed',
        added: { 'new-server': { description: 'New', uses: ['tools'] } },
      });

      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.method).toBe('featureSets/changed');
      expect(wire).not.toHaveProperty('id');
      expect(wire.params).toEqual({ added: { 'new-server': { description: 'New', uses: ['tools'] } } });
    });

    it('encodes mcpl/connect_server_result as notification (BUG 1 fix)', () => {
      const wire = codec.encode({
        type: 'mcpl/connect_server_result',
        serverId: 'srv-2',
        success: true,
      });

      expect(wire.method).toBe('mcpl/connectServerResult');
      expect(wire).not.toHaveProperty('id');
    });
  });

  // ---------------------------------------------------------------------------
  // encode: Request
  // ---------------------------------------------------------------------------

  describe('encode — Request', () => {
    it('encodes request with method + id', () => {
      const wire = codec.encode({
        type: 'mcpl/state_get',
        requestId: 'sg-1',
      });

      expect(wire.jsonrpc).toBe('2.0');
      expect(wire.id).toBe('sg-1');
      expect(wire.method).toBe('state/get');
    });

    it('tracks request in pendingRequests', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 'sg-2' });

      const pending = codec.getPendingRequests();
      expect(pending).toHaveLength(1);
      expect(pending[0][0]).toBe('sg-2');
      expect(pending[0][1].method).toBe('mcpl/state_get');
    });

    it('sends as notification with warning when requestId undefined (BUG 5)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const wire = codec.encode({ type: 'mcpl/scope_change_request', scopes: [] });

      expect(wire.method).toBe('scope/request');
      expect(wire).not.toHaveProperty('id');
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no requestId'));

      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // decode: JSON-RPC 2.0 → internal format
  // ---------------------------------------------------------------------------

  describe('decode — Success response', () => {
    it('decodes response using pendingRequests lookup', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 'dec-1' });

      const decoded = codec.decode({
        jsonrpc: '2.0',
        id: 'dec-1',
        result: { state: { key: 'val' } },
      });

      expect(decoded).not.toBeNull();
      expect(decoded!.type).toBe('mcpl/state_response');
      expect(decoded!.requestId).toBe('dec-1');
      expect((decoded as any).state).toEqual({ key: 'val' });
    });

    it('produces unknown_response for orphan response id', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const decoded = codec.decode({
        jsonrpc: '2.0',
        id: 'orphan-1',
        result: {},
      });

      expect(decoded!.type).toBe('mcpl/unknown_response');
      warnSpy.mockRestore();
    });

    it('state_rollback → state_response (BUG 3 fix)', () => {
      codec.encode({ type: 'mcpl/state_rollback', requestId: 'rb-1', checkpointId: 'cp-1' });

      const decoded = codec.decode({
        jsonrpc: '2.0',
        id: 'rb-1',
        result: { state: {} },
      });

      expect(decoded!.type).toBe('mcpl/state_response');
    });
  });

  describe('decode — Error response', () => {
    it('decodes JSON-RPC error to mcpl/error', () => {
      const decoded = codec.decode({
        jsonrpc: '2.0',
        id: 'err-1',
        error: { code: -32001, message: 'Disabled' },
      });

      expect(decoded!.type).toBe('mcpl/error');
      expect(decoded!.code).toBe(-32001);
      expect(decoded!.requestId).toBe('err-1');
    });
  });

  describe('decode — Request', () => {
    it('decodes JSON-RPC request to internal format', () => {
      const decoded = codec.decode({
        jsonrpc: '2.0',
        id: 'srv-1',
        method: 'context/beforeInference',
        params: { conversationId: 'conv-1' },
      });

      expect(decoded!.type).toBe('mcpl/beforeInference');
      expect(decoded!.requestId).toBe('srv-1');
      expect((decoded as any).conversationId).toBe('conv-1');
    });
  });

  describe('decode — Notification', () => {
    it('decodes JSON-RPC notification to internal format', () => {
      const decoded = codec.decode({
        jsonrpc: '2.0',
        method: 'inference/chunk',
        params: { chunk: 'data' },
      });

      expect(decoded!.type).toBe('mcpl/inference_chunk');
      expect(decoded).not.toHaveProperty('requestId');
    });
  });

  describe('decode — Legacy / passthrough', () => {
    it('returns null for non-JSON-RPC messages', () => {
      const decoded = codec.decode({ type: 'tool_manifest', tools: [] });
      expect(decoded).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Round-trip
  // ---------------------------------------------------------------------------

  describe('round-trip', () => {
    it('encode request → decode response preserves correlation', () => {
      const wire = codec.encode({
        type: 'mcpl/inference_request',
        requestId: 'rt-1',
        conversationId: 'conv-1',
      });

      // Simulate server processing: take wire, return response
      const decoded = codec.decode({
        jsonrpc: '2.0',
        id: wire.id,
        result: { response: 'hello world' },
      });

      expect(decoded!.type).toBe('mcpl/inference_response');
      expect(decoded!.requestId).toBe('rt-1');
    });

    it('multiple in-flight requests correlate correctly', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 'a' });
      codec.encode({ type: 'mcpl/checkpoint_list', requestId: 'b' });

      // Out-of-order responses
      const d1 = codec.decode({ jsonrpc: '2.0', id: 'b', result: { checkpoints: [] } });
      const d2 = codec.decode({ jsonrpc: '2.0', id: 'a', result: { state: {} } });

      expect(d1!.type).toBe('mcpl/checkpoint_list_response');
      expect(d2!.type).toBe('mcpl/state_response');
    });
  });

  // ---------------------------------------------------------------------------
  // pendingRequests persistence (BUG 6+7)
  // ---------------------------------------------------------------------------

  describe('pendingRequests — save/restore', () => {
    it('getPendingRequests returns snapshot', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 'x' });
      codec.encode({ type: 'mcpl/checkpoint_list', requestId: 'y' });

      const snapshot = codec.getPendingRequests();
      expect(snapshot).toHaveLength(2);
    });

    it('restorePendingRequests enables correlation on new codec', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 'old-1' });
      const snapshot = codec.getPendingRequests();

      const newCodec = createCodec();
      newCodec.restorePendingRequests(snapshot);

      const decoded = newCodec.decode({
        jsonrpc: '2.0',
        id: 'old-1',
        result: { state: { restored: true } },
      });

      expect(decoded!.type).toBe('mcpl/state_response');
    });

    it('does not include already-responded entries', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 'done' });
      codec.encode({ type: 'mcpl/checkpoint_list', requestId: 'pending' });

      // Respond to first
      codec.decode({ jsonrpc: '2.0', id: 'done', result: {} });

      expect(codec.getPendingRequests()).toHaveLength(1);
      expect(codec.getPendingRequests()[0][0]).toBe('pending');
    });
  });

  // ---------------------------------------------------------------------------
  // TTL cleanup
  // ---------------------------------------------------------------------------

  describe('pendingRequests — TTL cleanup', () => {
    it('cleanStalePending evicts entries older than 5 min', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      codec.restorePendingRequests([
        ['stale', { method: 'mcpl/state_get', ts: Date.now() - 6 * 60 * 1000 }],
        ['fresh', { method: 'mcpl/checkpoint_list', ts: Date.now() }],
      ]);

      codec.cleanStalePending();
      const remaining = codec.getPendingRequests();
      expect(remaining).toHaveLength(1);
      expect(remaining[0][0]).toBe('fresh');

      logSpy.mockRestore();
    });

    it('restorePendingRequests skips expired entries', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      codec.restorePendingRequests([
        ['expired', { method: 'mcpl/state_get', ts: Date.now() - 10 * 60 * 1000 }],
        ['valid', { method: 'mcpl/state_get', ts: Date.now() }],
      ]);

      expect(codec.getPendingRequests()).toHaveLength(1);
      expect(codec.getPendingRequests()[0][0]).toBe('valid');

      logSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('numeric requestId works', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 42 });

      const decoded = codec.decode({ jsonrpc: '2.0', id: 42, result: { state: {} } });
      expect(decoded!.type).toBe('mcpl/state_response');
      expect(decoded!.requestId).toBe(42);
    });

    it('PendingRequestsState survives JSON serialization', () => {
      codec.encode({ type: 'mcpl/state_get', requestId: 'ser-1' });
      const snapshot = codec.getPendingRequests();

      const json = JSON.stringify(snapshot);
      const restored: PendingRequestsState = JSON.parse(json);

      expect(restored).toHaveLength(1);
      expect(restored[0][1].method).toBe('mcpl/state_get');
      expect(typeof restored[0][1].ts).toBe('number');
    });
  });
});
