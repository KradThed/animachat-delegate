/**
 * Delegate WebSocket Connection
 *
 * Manages the persistent bidirectional WebSocket connection to the server.
 * Handles authentication, reconnection with backoff, heartbeat,
 * and ReliableChannel (seq/ack framing for MCPL messages).
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { ServerMessageSchema, type ServerMessage, type ToolCallRequest } from './types.js';
import type { McplCapability, McplAck, McplFeatureSet } from './mcpl-types.js';

// =============================================================================
// Types
// =============================================================================

export interface ConnectionOptions {
  serverUrl: string;
  token: string;
  delegateId: string;
  delegateName?: string;          // display name for MCPL (defaults to delegateId)
  capabilities: string[];
  /** MCPL capabilities to advertise (if set, enables MCPL protocol) */
  mcplCapabilities?: McplCapability[];
  /** Reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Heartbeat interval in ms (default: 30000) */
  heartbeatInterval?: number;
  /** Max reconnection attempts (default: Infinity) */
  maxReconnectAttempts?: number;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

interface ConnectionEvents {
  connected: (sessionId: string, userId: string) => void;
  disconnected: (code: number, reason: string) => void;
  reconnecting: (attempt: number) => void;
  tool_call_request: (request: ToolCallRequest) => void;
  trigger_inference_result: (result: ServerMessage) => void;
  tool_manifest_ack: (data: { toolCount: number; tools: string[] }) => void;
  mcpl_ack: (ack: McplAck) => void;
  error: (error: Error) => void;
  state_change: (state: ConnectionState) => void;
}

// =============================================================================
// DelegateConnection
// =============================================================================

export class DelegateConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<ConnectionOptions>;
  private state: ConnectionState = 'disconnected';
  private sessionId: string | null = null;
  private userId: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;

  /** True if MCPL protocol is active (hello/ack succeeded) */
  private _isMcpl = false;
  /** MCPL session ID (survives reconnects) */
  private mcplSessionId: string | null = null;
  /** Negotiated MCPL feature sets per serverId */
  private _featureSets: Record<string, McplFeatureSet> = {};

  // ReliableChannel state (embedded — option C from plan)
  private rcOutSeq = 0;
  private rcInSeq = 0;
  private rcLastAckedSeq = 0;
  private rcBuffer = new Map<number, Record<string, unknown>>();
  private rcPending = new Map<number, Record<string, unknown>>();
  private rcBareAckTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RC_MAX_UNACKED = 64;
  private static readonly RC_BARE_ACK_DELAY = 50;

  get isMcpl(): boolean { return this._isMcpl; }
  get featureSets(): Record<string, McplFeatureSet> { return this._featureSets; }

  constructor(options: ConnectionOptions) {
    super();
    this.options = {
      autoReconnect: true,
      heartbeatInterval: 30000,
      maxReconnectAttempts: Infinity,
      delegateName: options.delegateId,
      mcplCapabilities: [],
      ...options,
    };
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  get currentState(): ConnectionState { return this.state; }
  get isConnected(): boolean { return this.state === 'connected'; }

  /**
   * Connect to the server.
   */
  async connect(): Promise<void> {
    if (this.state !== 'disconnected') {
      throw new Error(`Cannot connect: state is ${this.state}`);
    }

    this.intentionalClose = false;
    return this.doConnect();
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.intentionalClose = true;
    this.cleanup();
    this.setState('disconnected');
    console.log('[Connection] Disconnected (intentional)');
  }

  /**
   * Send a message to the server.
   * MCPL messages (except mcpl/hello) are wrapped in ReliableChannel frames.
   * Legacy messages and mcpl/hello are sent raw.
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    // Frame MCPL messages (except mcpl/hello which is sent before RC exists)
    if (
      this._isMcpl &&
      typeof message.type === 'string' &&
      message.type.startsWith('mcpl/') &&
      message.type !== 'mcpl/hello'
    ) {
      const unacked = this.rcOutSeq - this.rcLastAckedSeq;
      if (unacked >= DelegateConnection.RC_MAX_UNACKED) {
        console.error('[Connection] Backpressure: too many unacked, disconnecting');
        this.ws.close(1008, 'backpressure: too many unacked frames');
        return;
      }
      const seq = ++this.rcOutSeq;
      const frame = { seq, ack: this.rcInSeq, payload: message };
      this.rcBuffer.set(seq, frame);
      this.ws.send(JSON.stringify(frame));
      // Cancel pending bare ack (piggybacked ack on this frame)
      if (this.rcBareAckTimer) {
        clearTimeout(this.rcBareAckTimer);
        this.rcBareAckTimer = null;
      }
    } else {
      this.ws.send(JSON.stringify(message));
    }
  }

  /**
   * Send tool manifest to advertise available tools.
   * Optionally includes duplicate warnings from MCP server tool collection.
   */
  sendToolManifest(
    tools: Array<{ name: string; description: string; inputSchema: unknown; serverName?: string }>,
    warnings?: Array<{ toolName: string; fromServer: string; conflictsWith: string }>
  ): void {
    this.send({
      type: 'tool_manifest',
      delegateId: this.options.delegateId,
      tools,
      ...(warnings?.length ? { warnings } : {}),
    });
    console.log(`[Connection] Sent tool manifest: ${tools.length} tools (${tools.map(t => t.name).join(', ')})`);
    if (warnings?.length) {
      console.warn(`[Connection] Included ${warnings.length} duplicate warning(s) in manifest`);
    }
  }

  /**
   * Send tool call response back to server.
   */
  sendToolCallResponse(
    requestId: string,
    toolUseId: string,
    content: string | unknown[],
    isError = false
  ): void {
    this.send({
      type: 'tool_call_response',
      requestId,
      toolUseId,
      result: { content, isError },
    });
  }

  /**
   * Send a trigger inference request (for external events/webhooks).
   */
  sendTriggerInference(params: {
    triggerId: string;
    source: string;
    conversationId?: string;
    participantId?: string;
    context: Record<string, unknown>;
    systemMessage?: string;
  }): void {
    this.send({
      type: 'trigger_inference',
      ...params,
    });
    console.log(`[Connection] Sent trigger: ${params.source} (${params.triggerId})`);
  }

  // --------------------------------------------------------------------------
  // Connection Logic
  // --------------------------------------------------------------------------

  private async doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting');

      const { serverUrl, token, delegateId } = this.options;
      const separator = serverUrl.includes('?') ? '&' : '?';

      // Support both JWT tokens and API keys (dak_xxx)
      // API keys start with "dak_", JWT tokens don't
      const isApiKey = token.startsWith('dak_');
      const authParam = isApiKey
        ? `apiKey=${encodeURIComponent(token)}`
        : `token=${encodeURIComponent(token)}`;
      const url = `${serverUrl}${separator}${authParam}&role=delegate&delegateId=${encodeURIComponent(delegateId)}`;

      console.log(`[Connection] Connecting to ${serverUrl} as delegate "${delegateId}"...`);

      try {
        this.ws = new WebSocket(url);
      } catch (error) {
        this.setState('disconnected');
        reject(error);
        return;
      }

      const connectionTimeout = setTimeout(() => {
        if (this.state === 'connecting' || this.state === 'authenticating') {
          console.error('[Connection] Connection timeout');
          this.ws?.terminate();
          this.setState('disconnected');
          reject(new Error('Connection timeout'));
        }
      }, 15000);

      this.ws.on('open', () => {
        this.setState('authenticating');
        console.log('[Connection] WebSocket opened, waiting for auth result...');
      });

      this.ws.on('message', (data) => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          console.warn('[Connection] Received invalid JSON');
          return;
        }

        const msg = raw as any;

        // Handle auth result specially during authentication phase
        if (this.state === 'authenticating') {
          if (msg.type === 'delegate_auth_result') {
            if (msg.success) {
              this.sessionId = msg.sessionId;
              this.userId = msg.userId;

              // If MCPL capabilities are configured, send mcpl/hello
              if (this.options.mcplCapabilities && this.options.mcplCapabilities.length > 0) {
                console.log(`[Connection] Auth OK, sending mcpl/hello (capabilities: ${this.options.mcplCapabilities.join(', ')})`);
                this.send({
                  type: 'mcpl/hello',
                  protocolVersion: 'mcpl-1.0',
                  capabilities: this.options.mcplCapabilities,
                  delegateId: this.options.delegateId,
                  delegateName: this.options.delegateName,
                  // On reconnect: send sessionId + lastReceivedSeq for resume
                  ...(this.mcplSessionId ? {
                    sessionId: this.mcplSessionId,
                    lastReceivedSeq: this.rcInSeq,
                  } : {}),
                });
                // Stay in authenticating state, wait for mcpl/ack
              } else {
                // Legacy flow — no MCPL
                clearTimeout(connectionTimeout);
                this.reconnectAttempts = 0;
                this.setState('connected');
                this.startHeartbeat();
                console.log(`[Connection] Authenticated! userId=${msg.userId}, session=${msg.sessionId}`);
                this.emit('connected', msg.sessionId, msg.userId);
                resolve();
              }
            } else {
              clearTimeout(connectionTimeout);
              const err = new Error(`Authentication failed: ${msg.error || 'unknown'}`);
              this.setState('disconnected');
              this.ws?.close();
              reject(err);
            }
            return;
          }

          // Handle mcpl/ack during authentication phase — may arrive as frame on resume
          if (msg.type === 'mcpl/ack') {
            // Plain mcpl/ack (new session, no framing yet)
            clearTimeout(connectionTimeout);
            this.handleMcplAckAuth(msg, resolve);
            return;
          }
          if (typeof msg.seq === 'number' && msg.payload?.type === 'mcpl/ack') {
            // Framed mcpl/ack (resume — server already has RC state)
            // Process ack from frame
            if (msg.ack > this.rcLastAckedSeq) {
              for (let i = this.rcLastAckedSeq + 1; i <= msg.ack; i++) this.rcBuffer.delete(i);
              this.rcLastAckedSeq = msg.ack;
            }
            this.rcInSeq = msg.seq;

            clearTimeout(connectionTimeout);
            const ackMsg = msg.payload;
            // If resumedFromSeq present — resend buffered frames
            if (typeof ackMsg.resumedFromSeq === 'number') {
              this.resendBufferedAfter(ackMsg.resumedFromSeq);
            }
            this.handleMcplAckAuth(ackMsg, resolve);
            return;
          }
        }

        // Connected phase: detect ReliableChannel frames
        if (this._isMcpl && typeof msg === 'object' && msg !== null && typeof msg.seq === 'number') {
          this.handleReliableFrame(msg);
          return;
        }

        // Normal message handling
        this.handleMessage(raw);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        this.stopHeartbeat();

        // Cancel pending bare ack timer
        if (this.rcBareAckTimer) {
          clearTimeout(this.rcBareAckTimer);
          this.rcBareAckTimer = null;
        }

        const reasonStr = reason.toString() || 'unknown';

        if (this.state === 'connecting' || this.state === 'authenticating') {
          this.setState('disconnected');
          reject(new Error(`Connection closed during setup: ${code} ${reasonStr}`));
          return;
        }

        this.setState('disconnected');
        this.emit('disconnected', code, reasonStr);
        console.log(`[Connection] Disconnected: ${code} ${reasonStr}`);

        // Name collision: delegate with same ID already connected — don't reconnect
        if (code === 4001) {
          console.error(`[Connection] Name collision: delegate "${this.options.delegateId}" already connected.`);
          console.error('[Connection] Use --delegate-id <name> to choose a different name.');
          return;
        }

        // Do NOT reset RC seq state — preserve for session resume on reconnect
        if (!this.intentionalClose && this.options.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        console.error('[Connection] WebSocket error:', error.message);
        this.emit('error', error);
      });

      this.ws.on('pong', () => {
        // WebSocket-level pong (from ws ping)
      });
    });
  }

  /**
   * Handle mcpl/ack during auth phase (shared between plain and framed paths).
   */
  private handleMcplAckAuth(ackMsg: any, resolve: () => void): void {
    this._isMcpl = true;
    this.mcplSessionId = ackMsg.sessionId;
    this._featureSets = ackMsg.featureSets || {};

    // If no resumedFromSeq → new session, reset RC state
    if (typeof ackMsg.resumedFromSeq !== 'number') {
      this.rcOutSeq = 0;
      this.rcInSeq = 0;
      this.rcLastAckedSeq = 0;
      this.rcBuffer.clear();
      this.rcPending.clear();
    }

    this.reconnectAttempts = 0;
    this.setState('connected');
    this.startHeartbeat();
    console.log(`[Connection] MCPL connected! session=${ackMsg.sessionId}, capabilities: ${(ackMsg.negotiatedCapabilities || []).join(', ')}${typeof ackMsg.resumedFromSeq === 'number' ? ' (resumed)' : ''}`);
    this.emit('connected', this.sessionId!, this.userId!);
    this.emit('mcpl_ack', ackMsg);
    resolve();
  }

  // --------------------------------------------------------------------------
  // ReliableChannel — frame handling (embedded, option C)
  // --------------------------------------------------------------------------

  private handleReliableFrame(frame: { seq: number; ack: number; payload?: Record<string, unknown> }): void {
    // Process ack — free confirmed outbound frames
    if (frame.ack > this.rcLastAckedSeq) {
      for (let i = this.rcLastAckedSeq + 1; i <= frame.ack; i++) this.rcBuffer.delete(i);
      this.rcLastAckedSeq = frame.ack;
    }

    // Bare ack (seq=0) or no payload → done
    if (frame.seq === 0 || !frame.payload) return;

    // Duplicate → ignore
    if (frame.seq <= this.rcInSeq) return;

    // Out-of-order → buffer for later
    if (frame.seq > this.rcInSeq + 1) {
      this.rcPending.set(frame.seq, frame.payload);
      return;
    }

    // In-order delivery + drain buffered successors
    this.rcInSeq = frame.seq;
    this.handleMcplMessage(frame.payload as any);

    while (this.rcPending.has(this.rcInSeq + 1)) {
      this.rcInSeq++;
      this.handleMcplMessage(this.rcPending.get(this.rcInSeq)! as any);
      this.rcPending.delete(this.rcInSeq);
    }

    this.scheduleBareAck();
  }

  private scheduleBareAck(): void {
    if (this.rcBareAckTimer) return; // already scheduled
    this.rcBareAckTimer = setTimeout(() => {
      this.rcBareAckTimer = null;
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ seq: 0, ack: this.rcInSeq }));
        }
      } catch {
        // Transport closing — ignore
      }
    }, DelegateConnection.RC_BARE_ACK_DELAY);
  }

  private resendBufferedAfter(afterSeq: number): void {
    const toResend = [...this.rcBuffer.entries()]
      .filter(([seq]) => seq > afterSeq)
      .sort(([a], [b]) => a - b);
    for (const [, frame] of toResend) {
      try {
        this.ws?.send(JSON.stringify(frame));
      } catch {
        break; // Transport failed — stop resending
      }
    }
  }

  // --------------------------------------------------------------------------
  // Message Handling
  // --------------------------------------------------------------------------

  private handleMessage(raw: unknown): void {
    // Handle MCPL messages first (not in legacy ServerMessageSchema)
    const rawMsg = raw as any;
    if (typeof rawMsg?.type === 'string' && rawMsg.type.startsWith('mcpl/')) {
      this.handleMcplMessage(rawMsg);
      return;
    }

    const parsed = ServerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      // Unknown message type — log and ignore for forward compatibility
      console.warn('[Connection] Unknown/invalid message:', JSON.stringify(raw).substring(0, 200));
      return;
    }

    const msg = parsed.data;

    switch (msg.type) {
      case 'tool_call_request':
        this.emit('tool_call_request', msg);
        break;

      case 'trigger_inference_result':
        this.emit('trigger_inference_result', msg);
        break;

      case 'tool_manifest_ack':
        console.log(`[Connection] Tool manifest acknowledged: ${msg.toolCount} tools`);
        this.emit('tool_manifest_ack', msg);
        break;

      case 'pong':
        // Heartbeat response — connection is alive
        break;

      case 'delegate_auth_result':
        // Already handled during auth phase
        break;
    }
  }

  // --------------------------------------------------------------------------
  // MCPL Message Handling
  // --------------------------------------------------------------------------

  private handleMcplMessage(msg: any): void {
    switch (msg.type) {
      case 'mcpl/beforeInference':
        this.emit('mcpl_before_inference', msg);
        break;

      case 'mcpl/afterInference':
        this.emit('mcpl_after_inference', msg);
        // Auto-ack for MVP
        try {
          this.send({ type: 'mcpl/afterInference_ack', requestId: msg.requestId });
        } catch { /* ignore */ }
        break;

      case 'mcpl/ack':
        // Handled during auth phase, but could arrive as re-ack
        break;

      case 'mcpl/inference_response':
        this.emit('mcpl_inference_response', msg);
        break;

      case 'mcpl/inference_chunk':
        this.emit('mcpl_inference_chunk', msg);
        break;

      case 'mcpl/scope_change_result':
        this.emit('mcpl_scope_change_result', msg);
        if (msg.approved && msg.newCapabilities) {
          console.log(`[Connection] Scope change approved: ${msg.newCapabilities.join(', ')}`);
        } else {
          console.log(`[Connection] Scope change denied (requestId: ${msg.requestId})`);
        }
        break;

      case 'mcpl/connect_server':
        console.log(`[Connection] Received mcpl/connect_server: ${msg.url}`);
        this.emit('mcpl_connect_server', msg);
        break;

      case 'mcpl/model_info_response':
        this.emit('mcpl_model_info_response', msg);
        break;

      case 'mcpl/scope_elevate_result':
        this.emit('mcpl_scope_elevate_result', msg);
        if (msg.approved) {
          console.log(`[Connection] Scope elevate approved: ${(msg.newCapabilities || []).join(', ')}`);
        } else {
          console.log(`[Connection] Scope elevate denied (requestId: ${msg.requestId})`);
        }
        break;

      case 'mcpl/state_patch_result':
        this.emit('mcpl_state_patch_result', msg);
        break;

      case 'mcpl/state_response':
        this.emit('mcpl_state_response', msg);
        break;

      case 'mcpl/checkpoint_list_response':
        this.emit('mcpl_checkpoint_list_response', msg);
        break;

      case 'mcpl/error':
        // Fix #4: server-side error (access denied, rate limited, etc.)
        console.warn(
          `[Connection] MCPL error: code=${msg.code}, message="${msg.message}"` +
          (msg.retryAfterMs ? `, retryAfter=${msg.retryAfterMs}ms` : '') +
          (msg.inReplyTo?.type ? `, inReplyTo=${msg.inReplyTo.type}` : '')
        );
        this.emit('mcpl_error', msg);
        break;

      default:
        console.log(`[Connection] Unhandled MCPL message: ${msg.type}`);
    }
  }

  /**
   * Send a beforeInference response with context injections.
   */
  sendBeforeInferenceResponse(requestId: string, injections: Array<{
    serverId: string;
    position: 'system' | 'beforeUser' | 'afterUser';
    content: string;
  }>): void {
    this.send({
      type: 'mcpl/beforeInference_response',
      requestId,
      injections,
    });
  }

  /**
   * Send a push event to the server.
   */
  sendPushEvent(event: {
    id: string;
    source: string;
    conversationId: string;
    eventType: string;
    payload: unknown;
    systemMessage: string;
    idempotencyKey: string;
  }): void {
    this.send({
      type: 'mcpl/push_event',
      ...event,
      timestamp: new Date().toISOString(),
    });
    console.log(`[Connection] Sent MCPL push event: ${event.source}/${event.eventType} (${event.id})`);
  }

  /**
   * Send an inference request to the host (MCPL only).
   */
  sendInferenceRequest(request: {
    requestId: string;
    serverId: string;
    conversationId: string;
    systemMessage?: string;
    userMessage: string;
    maxTokens?: number;
    stream?: boolean;
    parentChainId?: string;   // Fix #5: chain tracking for recursion prevention
    parentFrameId?: string;   // Fix #5: frame tracking for recursion prevention
  }): void {
    this.send({
      type: 'mcpl/inference_request',
      ...request,
    });
    console.log(`[Connection] Sent MCPL inference request: ${request.requestId}`);
  }

  /**
   * Send a scope change request (MCPL only).
   */
  sendScopeChangeRequest(request: {
    requestId: string;
    serverId: string;
    conversationId: string;
    url: string;
    serverName: string;
    requestedCapabilities: string[];
    reason: string;
  }): void {
    this.send({
      type: 'mcpl/scope_change_request',
      ...request,
    });
    console.log(`[Connection] Sent scope change request: ${request.serverName} (${request.url}) → ${request.requestedCapabilities.join(', ')}`);
  }

  /**
   * Send a connect_server_result back to the server (MCPL only).
   */
  sendConnectServerResult(result: {
    requestId: string;
    url: string;
    success: boolean;
    serverId?: string;
    tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
    error?: string;
  }): void {
    this.send({
      type: 'mcpl/connect_server_result',
      ...result,
    });
    console.log(`[Connection] Sent connect_server_result: ${result.url} (${result.success ? 'success' : 'failed'})`);
  }

  /**
   * Send a scope elevate request to the backend (Phase 7 — Batch 4).
   * Delegate holds the JSON-RPC request open while waiting for approval.
   */
  sendScopeElevateRequest(request: {
    requestId: string;
    delegateId: string;
    serverId: string;
    conversationId: string;
    featureSet: string;
    label: string;
    requestedCapabilities: string[];
    reason: string;
    timeoutMs?: number;
  }): void {
    this.send({
      type: 'mcpl/scope_elevate_request',
      ...request,
    });
    console.log(`[Connection] Sent scope_elevate_request: ${request.featureSet}/${request.label} → ${request.requestedCapabilities.join(', ')}`);
  }

  /**
   * Send updated featureSets to the server (Phase 7 — Batch 2a).
   * Full replacement — server computes diff and auto-disables removed servers.
   * Called when MCP servers are added/removed dynamically at runtime.
   */
  sendFeatureSetsChanged(featureSets: Record<string, import('./mcpl-types.js').McplFeatureSet>): void {
    this.send({
      type: 'mcpl/featureSets_changed',
      featureSets,
    });
    console.log(`[Connection] Sent featureSets_changed: ${Object.keys(featureSets).length} server(s)`);
  }

  /**
   * Set (replace) conversation state on the backend (Phase 7 — Batch 2b).
   * Fire-and-forget for MVP (requestId included for consistency/future ack).
   */
  sendStateSet(requestId: string, conversationId: string, state: Record<string, unknown>): void {
    this.send({
      type: 'mcpl/state_set',
      requestId,
      conversationId,
      state,
    });
    console.log(`[Connection] Sent state_set for ${conversationId}`);
  }

  /**
   * Apply JSON Patch (RFC 6902) to conversation state on the backend.
   * Server responds with mcpl/state_patch_result.
   */
  sendStatePatch(requestId: string, conversationId: string, patch: unknown[]): void {
    this.send({
      type: 'mcpl/state_patch',
      requestId,
      conversationId,
      patch,
    });
    console.log(`[Connection] Sent state_patch for ${conversationId} (${patch.length} ops)`);
  }

  /**
   * Request rollback to last checkpoint on the backend.
   * Server responds with mcpl/state_response.
   */
  sendStateRollback(requestId: string, conversationId: string, checkpointId?: string): void {
    this.send({
      type: 'mcpl/state_rollback',
      requestId,
      conversationId,
      ...(checkpointId ? { checkpointId } : {}),
    });
    console.log(`[Connection] Sent state_rollback for ${conversationId}`);
  }

  /**
   * Request checkpoint list from the backend.
   * Server responds with mcpl/checkpoint_list_response.
   */
  sendCheckpointList(requestId: string, conversationId: string): void {
    this.send({
      type: 'mcpl/checkpoint_list',
      requestId,
      conversationId,
    });
    console.log(`[Connection] Sent checkpoint_list for ${conversationId}`);
  }

  /**
   * Request current state from the backend.
   * Server responds with mcpl/state_response.
   */
  sendStateGet(requestId: string, conversationId: string): void {
    this.send({
      type: 'mcpl/state_get',
      requestId,
      conversationId,
    });
    console.log(`[Connection] Sent state_get for ${conversationId}`);
  }

  /**
   * Request model capabilities from the backend (Phase 7).
   * Delegate is a transparent proxy — just forwards request/response from MCP server.
   */
  sendModelInfoRequest(requestId: string): void {
    this.send({
      type: 'mcpl/model_info_request',
      requestId,
    });
    console.log(`[Connection] Sent model_info_request: ${requestId}`);
  }

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.send({ type: 'ping', timestamp: Date.now() });
        } catch {
          // Ignore send errors — disconnect handler will take care of it
        }
      }
    }, this.options.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // --------------------------------------------------------------------------
  // Reconnection
  // --------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error(`[Connection] Max reconnect attempts (${this.options.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    console.log(`[Connection] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.doConnect();
        // Re-emit connected so tools can be re-registered
      } catch (error) {
        console.error(`[Connection] Reconnect failed:`, error instanceof Error ? error.message : error);
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  // --------------------------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------------------------

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.rcBareAckTimer) {
      clearTimeout(this.rcBareAckTimer);
      this.rcBareAckTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('state_change', state);
    }
  }
}
