/**
 * MCPL JSON-RPC 2.0 Codec (delegate-side)
 *
 * Stateless encoder/decoder that converts between internal message format
 * ({ type: 'mcpl/...', requestId, ...fields }) and JSON-RPC 2.0 wire format.
 *
 * Unlike the backend McplCodec (which wraps a McplTransport), the delegate
 * version is a plain encoder/decoder because the delegate has an embedded
 * ReliableChannel (option C) — no McplTransport interface to wrap.
 *
 * Usage in connection.ts:
 *   const codec = new McplCodec();
 *   // On send: connection.send() calls codec.encode() before RC framing
 *   // On receive: handleReliableFrame() calls codec.decode() before handleMcplMessage()
 */

import {
  RESPONSE_TYPE_MAP,
  REQUEST_TO_RESPONSE_TYPE,
  NOTIFICATION_TYPES,
  INTERNAL_TO_WIRE,
  WIRE_TO_INTERNAL,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
} from './mcpl-jsonrpc.js';

// =============================================================================
// McplCodec
// =============================================================================

/** Serializable snapshot of pending requests for session resume. */
export type PendingRequestsState = Array<[string | number, { method: string; ts: number }]>;

/** Default TTL for pending requests (5 minutes). */
const PENDING_TTL_MS = 5 * 60 * 1000;

export class McplCodec {
  /**
   * Tracks outgoing requests: id → { method, ts }.
   * Populated on encode (request), consumed on decode (response).
   * Used to map JSON-RPC responses (which have no `method`) back to
   * the correct internal response type via REQUEST_TO_RESPONSE_TYPE.
   *
   * Entries include a timestamp for TTL-based cleanup — if a response
   * never arrives, stale entries are evicted instead of leaking forever.
   */
  private pendingRequests = new Map<string | number, { method: string; ts: number }>();

  // ---------------------------------------------------------------------------
  // encode: internal format → JSON-RPC 2.0
  // ---------------------------------------------------------------------------

  encode(msg: Record<string, unknown>): Record<string, unknown> {
    const type = msg.type as string;
    const requestId = msg.requestId as string | number | undefined;

    // 1. Response — type is in RESPONSE_TYPE_MAP
    if (RESPONSE_TYPE_MAP[type]) {
      const { type: _, requestId: __, ...rest } = msg;
      return {
        jsonrpc: '2.0',
        id: requestId ?? null,
        result: rest,
      };
    }

    // 2. Error — special handling for mcpl/error
    if (type === 'mcpl/error') {
      const data: Record<string, unknown> = {};
      if (msg.retryAfterMs !== undefined) data.retryAfterMs = msg.retryAfterMs;
      if (msg.inReplyTo !== undefined) data.inReplyTo = msg.inReplyTo;

      return {
        jsonrpc: '2.0',
        id: requestId ?? null,
        error: {
          code: msg.code as number,
          message: msg.message as string,
          ...(Object.keys(data).length > 0 ? { data } : {}),
        },
      };
    }

    // F1 fix: Translate internal method name → spec wire name
    const wireMethod = INTERNAL_TO_WIRE[type] ?? type;

    // 3. Notification — fire-and-forget, no id
    if (NOTIFICATION_TYPES.has(type)) {
      const { type: _, ...rest } = msg;
      return {
        jsonrpc: '2.0',
        method: wireMethod,
        params: rest,
      };
    }

    // 4. Request — expects a response (must have requestId to be a valid JSON-RPC request)
    const { type: _, requestId: __, ...rest } = msg;
    if (requestId === undefined) {
      console.warn(`[McplCodec] Request "${type}" has no requestId — encoding as notification`);
      return {
        jsonrpc: '2.0',
        method: wireMethod,
        params: rest,
      };
    }
    this.pendingRequests.set(requestId, { method: type, ts: Date.now() });
    return {
      jsonrpc: '2.0',
      id: requestId,
      method: wireMethod,
      params: rest,
    };
  }

  // ---------------------------------------------------------------------------
  // decode: JSON-RPC 2.0 → internal format
  // ---------------------------------------------------------------------------

  /**
   * Decode a JSON-RPC 2.0 message into internal format.
   * Returns null for unrecognized/legacy messages (caller should handle raw).
   */
  decode(raw: Record<string, unknown>): Record<string, unknown> | null {
    // Not JSON-RPC? Return null — caller handles as legacy
    if (raw.jsonrpc !== '2.0') {
      return null;
    }

    // 1. Error response
    if (isJsonRpcErrorResponse(raw)) {
      const id = raw.id as string | number | null;
      const error = raw.error as { code: number; message: string; data?: Record<string, unknown> };
      const data = (error.data && typeof error.data === 'object') ? error.data as Record<string, unknown> : {};

      // Clean up pending request
      if (id !== null && id !== undefined) {
        this.pendingRequests.delete(id);
      }

      return {
        type: 'mcpl/error',
        ...(id !== null && id !== undefined ? { requestId: id } : {}),
        code: error.code,
        message: error.message,
        ...data,
      };
    }

    // 2. Success response (has result + id, no method)
    if (isJsonRpcResponse(raw)) {
      const id = raw.id as string | number;
      const result = raw.result;

      // Look up which method this responds to
      const entry = this.pendingRequests.get(id);
      this.pendingRequests.delete(id);
      const method = entry?.method;

      if (method) {
        // Find the internal response type for this method
        const responseType = REQUEST_TO_RESPONSE_TYPE[method];
        if (responseType) {
          // M2 fix: preserve non-object results (primitives, arrays) in a `result` field
          // instead of silently dropping them
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            return {
              type: responseType,
              requestId: id,
              ...(result as Record<string, unknown>),
            };
          }
          return {
            type: responseType,
            requestId: id,
            result,
          };
        }
      }

      // Fallback: unknown response
      console.warn(`[McplCodec] Response for unknown request id=${id}, method=${method ?? 'unknown'}`);
      return {
        type: 'mcpl/unknown_response',
        requestId: id,
        result,
      };
    }

    // 3. Request (has method + id)
    if (isJsonRpcRequest(raw)) {
      const wireMethod = raw.method as string;
      // F1 fix: Translate spec wire name → internal name
      const internalType = WIRE_TO_INTERNAL[wireMethod] ?? wireMethod;
      const id = raw.id as string | number;
      const params = (raw.params && typeof raw.params === 'object')
        ? raw.params as Record<string, unknown>
        : {};

      return {
        type: internalType,
        requestId: id,
        ...params,
      };
    }

    // 4. Notification (has method, no id)
    if (isJsonRpcNotification(raw)) {
      const wireMethod = raw.method as string;
      // F1 fix: Translate spec wire name → internal name
      const internalType = WIRE_TO_INTERNAL[wireMethod] ?? wireMethod;
      const params = (raw.params && typeof raw.params === 'object')
        ? raw.params as Record<string, unknown>
        : {};

      return {
        type: internalType,
        ...params,
      };
    }

    // Unknown format — return null, caller handles
    console.warn('[McplCodec] Unrecognized JSON-RPC message:', JSON.stringify(raw).substring(0, 200));
    return null;
  }

  // ---------------------------------------------------------------------------
  // pendingRequests persistence (BUG 6+7 fix: survive session resume)
  // ---------------------------------------------------------------------------

  /**
   * Snapshot pending requests for preserving across reconnects.
   * Called before destroying the codec on disconnect.
   */
  getPendingRequests(): PendingRequestsState {
    this.cleanStalePending();
    return [...this.pendingRequests.entries()];
  }

  /**
   * Restore pending requests from a saved snapshot.
   * Called on session resume (new codec inherits state from previous).
   */
  restorePendingRequests(state: PendingRequestsState): void {
    const now = Date.now();
    let restoredCount = 0;
    for (const [id, entry] of state) {
      // Skip entries that have already expired
      if (now - entry.ts > PENDING_TTL_MS) continue;
      this.pendingRequests.set(id, entry);
      restoredCount++;
    }
    if (restoredCount > 0) {
      console.log(`[McplCodec] Restored ${restoredCount} pending request(s) from saved state`);
    }
  }

  /**
   * Evict stale pending requests (TTL expired, response never arrived).
   */
  cleanStalePending(): void {
    const now = Date.now();
    let evictedCount = 0;
    for (const [id, entry] of this.pendingRequests) {
      if (now - entry.ts > PENDING_TTL_MS) {
        this.pendingRequests.delete(id);
        evictedCount++;
      }
    }
    if (evictedCount > 0) {
      console.log(`[McplCodec] Evicted ${evictedCount} stale pending request(s) (TTL > ${PENDING_TTL_MS / 1000}s)`);
    }
  }
}
