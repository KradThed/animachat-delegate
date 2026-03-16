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
import type { McplCapabilities, McplAck, McplFeatureSet } from './mcpl-types.js';
import { McplCodec } from './mcpl-codec.js';

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
  mcplCapabilities?: McplCapabilities;
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
  tool_manifest_ack: (data: { toolCount: number; tools: string[]; warnings?: Array<{ toolName: string; reason: string }> }) => void;
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
  /** §6.6: Enabled featureSet names (populated from ack, updated by featureSets/update) */
  private _enabledFeatureSets = new Set<string>();
  /** S1: Scope policies per featureSet from featureSets/update (§7.2 whitelist/blacklist) */
  private _featureSetScopes: Record<string, { whitelist?: string[]; blacklist?: string[] }> = {};
  /** JSON-RPC 2.0 codec for MCPL messages (created after hello/ack handshake) */
  private mcplCodec: McplCodec | null = null;

  // ReliableChannel state (embedded — option C from plan)
  private rcOutSeq = 0;
  private rcInSeq = 0;
  private rcLastAckedSeq = 0;
  private rcBuffer = new Map<number, { frame: Record<string, unknown>; ts: number }>();
  private rcPending = new Map<number, Record<string, unknown>>();
  private rcBareAckTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly RC_MAX_UNACKED = 64;
  private static readonly RC_BARE_ACK_DELAY = 50;
  private static readonly RC_MAX_BUFFER_AGE = 120_000; // DEL-1: 2 min max age for buffered frames
  private static readonly RC_MAX_PENDING = 256; // Max out-of-order frames before disconnect

  // B4: mcpl/hello timeout — close socket if mcpl/ack never arrives
  private mcplHelloTimeout: ReturnType<typeof setTimeout> | null = null;

  // DEL-4: WS-level ping dead connection detection
  private pongReceived = true;

  get isMcpl(): boolean { return this._isMcpl; }
  get featureSets(): Record<string, McplFeatureSet> { return this._featureSets; }
  /** S1: Scope policies per featureSet (§7.2) */
  get featureSetScopes(): Record<string, { whitelist?: string[]; blacklist?: string[] }> { return this._featureSetScopes; }

  /** §6.6: Check if a featureSet name is enabled by the host.
   *  Returns 'enabled' | 'disabled' | 'unknown'. */
  checkFeatureSet(name: string): 'enabled' | 'disabled' | 'unknown' {
    if (this._enabledFeatureSets.has(name)) return 'enabled';
    if (name in this._featureSets) return 'disabled';
    return 'unknown';
  }

  /** DEL-2: Redact auth tokens from URLs for safe logging */
  private static redactUrl(url: string): string {
    return url
      .replace(/([?&])(apiKey|token)=[^&]*/gi, '$1$2=[REDACTED]')
      // BUG-10 fix: also redact dak_* API key tokens appearing in URL path
      .replace(/\bdak_[A-Za-z0-9_-]+/g, '[REDACTED]');
  }

  constructor(options: ConnectionOptions) {
    super();
    this.options = {
      autoReconnect: true,
      heartbeatInterval: 30000,
      maxReconnectAttempts: Infinity,
      delegateName: options.delegateId,
      mcplCapabilities: {},
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
   *
   * IMPORTANT: All mcpl/* messages (except mcpl/hello) are IMPLICITLY wrapped in
   * ReliableChannel seq/ack framing AND encoded to JSON-RPC 2.0 via McplCodec.
   * Any new mcpl/* message type MUST be sent via this.send(), never via
   * this.ws.send() directly — otherwise it bypasses RC ordering guarantees
   * and the JSON-RPC 2.0 wire format.
   */
  send(message: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }

    // Frame MCPL messages (except mcpl/hello which is sent before RC/codec exists)
    if (
      this._isMcpl &&
      typeof message.type === 'string' &&
      message.type.startsWith('mcpl/') &&
      message.type !== 'mcpl/hello'
    ) {
      // H3 fix: prune stale frames before backpressure check to avoid false disconnects
      const now = Date.now();
      for (const [seq, entry] of this.rcBuffer) {
        if (now - entry.ts > DelegateConnection.RC_MAX_BUFFER_AGE) {
          this.rcBuffer.delete(seq);
        }
      }
      const unacked = this.rcOutSeq - this.rcLastAckedSeq;
      if (unacked >= DelegateConnection.RC_MAX_UNACKED) {
        console.error('[Connection] Backpressure: too many unacked, disconnecting');
        this.ws.close(1008, 'backpressure: too many unacked frames');
        return;
      }
      // Encode internal format → JSON-RPC 2.0 via codec
      const wireMsg = this.mcplCodec ? this.mcplCodec.encode(message) : message;
      const seq = ++this.rcOutSeq;
      const frame = { seq, ack: this.rcInSeq, payload: wireMsg };
      this.rcBuffer.set(seq, { frame, ts: Date.now() });
      // BUG-9 fix: ws.send() can throw if socket closes between readyState check
      // and actual send. Wrap in try/catch — frame is buffered for resend on resume.
      try {
        this.ws.send(JSON.stringify(frame));
      } catch {
        // Frame is in rcBuffer — will be resent on reconnect
        return;
      }
      // Cancel pending bare ack (piggybacked ack on this frame)
      if (this.rcBareAckTimer) {
        clearTimeout(this.rcBareAckTimer);
        this.rcBareAckTimer = null;
      }
    } else {
      try {
        this.ws.send(JSON.stringify(message));
      } catch {
        // Legacy send failed (socket closing) — no retry for non-RC messages
      }
    }
  }

  /**
   * Send tool manifest to advertise available tools.
   * Optionally includes duplicate warnings from MCP server tool collection.
   */
  sendToolManifest(
    tools: Array<{ name: string; description: string; inputSchema: unknown; serverName?: string }>,
    warnings?: Array<{ toolName: string; fromServer: string; conflictsWith: string }>,
    /** Optional reason for manifest update (Feature 4: toolset history tracking) */
    reason?: string,
  ): void {
    this.send({
      type: 'tool_manifest',
      delegateId: this.options.delegateId,
      tools,
      timestamp: new Date().toISOString(),
      ...(reason ? { reason } : {}),
      ...(warnings?.length ? { warnings } : {}),
    });
    console.log(`[Connection] Sent tool manifest: ${tools.length} tools (${tools.map(t => t.name).join(', ')})${reason ? ` [${reason}]` : ''}`);
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
      this.pongReceived = true; // DEL-4: reset for new connection

      const { serverUrl, token, delegateId } = this.options;
      const separator = serverUrl.includes('?') ? '&' : '?';

      // Auth credentials sent as first message after open (not in URL to avoid proxy log leaks)
      const url = `${serverUrl}${separator}role=delegate&delegateId=${encodeURIComponent(delegateId)}`;

      console.log(`[Connection] Connecting to ${DelegateConnection.redactUrl(url)} as delegate "${delegateId}"...`);

      try {
        this.ws = new WebSocket(url);
      } catch (error) {
        this.setState('disconnected');
        reject(error);
        return;
      }

      // DEL-3: Single-settle guard — prevents double resolve/reject race
      let settled = false;
      const trySettle = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(connectionTimeout);
        return true;
      };

      const connectionTimeout = setTimeout(() => {
        if (!trySettle()) return;
        console.error('[Connection] Connection timeout');
        this.ws?.terminate();
        this.setState('disconnected');
        reject(new Error('Connection timeout'));
      }, 15000);

      this.ws.on('open', () => {
        this.setState('authenticating');
        // Send auth credentials as first message (not in URL to avoid proxy log leaks)
        const isApiKey = token.startsWith('dak_');
        try {
          this.ws!.send(JSON.stringify({
            type: 'delegate_auth',
            ...(isApiKey ? { apiKey: token } : { token }),
            delegateId,
          }));
        } catch {
          // Socket closed between open event and send — reconnect will handle
          return;
        }
        console.log('[Connection] WebSocket opened, sent auth, waiting for result...');
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

              // H5: If MCPL capabilities are configured, send MCP initialize with experimental.mcpl
              if (this.options.mcplCapabilities && Object.keys(this.options.mcplCapabilities).length > 0) {
                console.log(`[Connection] Auth OK, sending initialize (mcpl: ${JSON.stringify(this.options.mcplCapabilities)})`);
                const helloRequestId = `hello-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                // H5: Send standard MCP initialize request with MCPL in experimental
                try {
                  this.ws!.send(JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'initialize',
                    id: helloRequestId,
                    params: {
                      protocolVersion: '2024-11-05',
                      clientInfo: { name: this.options.delegateName, version: '1.0.0' },
                      capabilities: {
                        experimental: {
                          mcpl: {
                            ...this.options.mcplCapabilities,
                            featureSets: this._featureSets,  // wire name = featureSets (dict of declared sets)
                          },
                        },
                      },
                      _mcpl: {
                        delegateId: this.options.delegateId,
                        ...(this.mcplSessionId ? {
                          sessionId: this.mcplSessionId,
                          lastReceivedSeq: this.rcInSeq,
                        } : {}),
                      },
                    },
                  }));
                } catch {
                  // Socket closed — reconnect will handle
                  return;
                }
                // B4 fix: timeout if mcpl/ack never arrives
                this.mcplHelloTimeout = setTimeout(() => {
                  console.warn('[Connection] mcpl/ack timeout (15s) — closing socket');
                  this.ws?.close();
                }, 15_000);
                // Stay in authenticating state, wait for mcpl/ack
              } else {
                // Legacy flow — no MCPL
                if (!trySettle()) return; // DEL-3
                this.reconnectAttempts = 0;
                this.setState('connected');
                this.startHeartbeat();
                console.log(`[Connection] Authenticated! userId=${msg.userId}, session=${msg.sessionId}`);
                this.emit('connected', msg.sessionId, msg.userId);
                resolve();
              }
            } else {
              if (!trySettle()) return; // DEL-3
              const err = new Error(`Authentication failed: ${msg.error || 'unknown'}`);
              this.setState('disconnected');
              this.ws?.close();
              reject(err);
            }
            return;
          }

          // Handle mcpl/ack during authentication phase.
          // Server sends ack as JSON-RPC 2.0 response: { jsonrpc: "2.0", id, result: { sessionId, ... } }
          // May arrive plain (new session) or framed in RC (resume).

          // 1. Plain JSON-RPC response (new session, no framing yet)
          if (msg.jsonrpc === '2.0' && 'result' in msg && !('seq' in msg)) {
            const ackPayload = msg.result as Record<string, unknown>;
            if (!trySettle()) return; // DEL-3
            this.handleMcplAckAuth(ackPayload, resolve, reject);
            return;
          }

          // 2. Framed JSON-RPC response (resume — server already has RC state)
          if (typeof msg.seq === 'number' && msg.payload?.jsonrpc === '2.0' && 'result' in (msg.payload as any)) {
            // Process ack from frame (M1 fix: type-check msg.ack)
            if (typeof msg.ack === 'number' && msg.ack > this.rcLastAckedSeq) {
              for (let i = this.rcLastAckedSeq + 1; i <= msg.ack; i++) this.rcBuffer.delete(i);
              this.rcLastAckedSeq = msg.ack;
            }
            this.rcInSeq = msg.seq;

            if (!trySettle()) return; // DEL-3
            const ackPayload = (msg.payload as any).result as Record<string, unknown>;
            // H5: Extract resumedFromSeq from _mcpl nested field (with fallback)
            const mcplResume = (ackPayload._mcpl as Record<string, unknown>) || ackPayload;
            if (typeof mcplResume.resumedFromSeq === 'number') {
              this.resendBufferedAfter(mcplResume.resumedFromSeq);
            }
            this.handleMcplAckAuth(ackPayload, resolve, reject);
            return;
          }
        }

        // H1 fix: Top-level error boundary — prevent uncaught exceptions from crashing process
        try {
          // Connected phase: detect ReliableChannel frames
          if (this._isMcpl && typeof msg === 'object' && msg !== null && typeof msg.seq === 'number') {
            this.handleReliableFrame(msg);
            return;
          }

          // Normal message handling
          this.handleMessage(raw);
        } catch (err) {
          console.error('[Connection] Unhandled error in message handler:', err);
        }
      });

      this.ws.on('close', (code, reason) => {
        this.stopHeartbeat();

        // B4: cancel hello timeout on close
        if (this.mcplHelloTimeout) {
          clearTimeout(this.mcplHelloTimeout);
          this.mcplHelloTimeout = null;
        }

        // Cancel pending bare ack timer
        if (this.rcBareAckTimer) {
          clearTimeout(this.rcBareAckTimer);
          this.rcBareAckTimer = null;
        }

        const reasonStr = reason.toString() || 'unknown';

        if (this.state === 'connecting' || this.state === 'authenticating') {
          if (trySettle()) { // DEL-3
            this.setState('disconnected');
            reject(new Error(`Connection closed during setup: ${code} ${reasonStr}`));
          }
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
        this.pongReceived = true; // DEL-4: WS-level pong received
      });
    });
  }

  /**
   * Handle initialize result during auth phase (shared between plain and framed paths).
   * H5: Parses MCP initializeResult with experimental.mcpl nested capabilities.
   */
  private handleMcplAckAuth(ackMsg: any, resolve: () => void, reject?: (err: Error) => void): void {
    // B4: cancel hello timeout — ack arrived
    if (this.mcplHelloTimeout) {
      clearTimeout(this.mcplHelloTimeout);
      this.mcplHelloTimeout = null;
    }
    this._isMcpl = true;

    // H5: Extract MCPL data from initializeResult structure
    const mcplData = ackMsg._mcpl || ackMsg; // fallback for backward compat
    this.mcplSessionId = mcplData.sessionId || ackMsg.sessionId;
    // П6: On reconnect, merge backend's ack featureSets with locally-known ones.
    // This closes the window where webhooks fire before connected handler re-sends featureSets/changed.
    const ackCaps = ackMsg.capabilities?.experimental?.mcpl;
    const ackFeatureSets = (typeof ackCaps?.featureSets === 'object' && ackCaps.featureSets !== null)
      ? ackCaps.featureSets : {};
    const previousLocal = this._featureSets;
    this._featureSets = { ...previousLocal, ...ackFeatureSets };
    // §6.6: All known featureSets start enabled after (re)connect
    this._enabledFeatureSets = new Set(Object.keys(this._featureSets));
    const resumedFromSeq = mcplData.resumedFromSeq ?? ackMsg.resumedFromSeq;

    // Initialize JSON-RPC codec for subsequent MCPL messages.
    // On resume: preserve pending requests from previous codec (BUG 6+7 fix).
    const previousPending = this.mcplCodec?.getPendingRequests();
    this.mcplCodec = new McplCodec();
    if (previousPending && previousPending.length > 0) {
      this.mcplCodec.restorePendingRequests(previousPending);
    }

    // If no resumedFromSeq → new session, reset RC state
    if (typeof resumedFromSeq !== 'number') {
      this.rcOutSeq = 0;
      this.rcInSeq = 0;
      this.rcLastAckedSeq = 0;
      this.rcBuffer.clear();
      this.rcPending.clear();
    } else {
      // Resume: clear stale pending frames (server RC state may have changed)
      this.rcPending.clear();
    }

    this.reconnectAttempts = 0;
    this.setState('connected');
    this.startHeartbeat();
    const mcplCaps = ackMsg.capabilities?.experimental?.mcpl || ackMsg.negotiatedCapabilities || {};
    console.log(`[Connection] MCPL connected! session=${this.mcplSessionId}, capabilities: ${JSON.stringify(mcplCaps)}${typeof resumedFromSeq === 'number' ? ' (resumed)' : ''}`);
    // BUG-6 fix: guard against null sessionId/userId (set during delegate_auth_result).
    // Should never be null here, but if auth_result had missing fields, non-null assertion
    // would mask the problem. Defensive check + clear error is safer.
    if (!this.sessionId || !this.userId) {
      const err = new Error('MCPL ack received but sessionId or userId is null — auth_result was incomplete');
      console.error(`[Connection] ${err.message}`);
      this.ws?.close(4500, 'incomplete_auth');
      if (reject) reject(err);
      return;
    }
    this.emit('connected', this.sessionId, this.userId);
    this.emit('mcpl_ack', ackMsg);

    // H5: Send notifications/initialized per MCP spec (completes initialize handshake)
    try {
      this.ws?.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    } catch {
      // Socket closing — non-critical
    }

    resolve();
  }

  // --------------------------------------------------------------------------
  // ReliableChannel — frame handling (embedded, option C)
  // --------------------------------------------------------------------------

  private handleReliableFrame(frame: { seq: number; ack: number; payload?: Record<string, unknown> }): void {
    // Process ack — free confirmed outbound frames (DEL-1: rcBuffer stores { frame, ts })
    // RC ack upper bound: ignore bogus acks beyond what we've sent
    if (frame.ack > this.rcLastAckedSeq && frame.ack <= this.rcOutSeq) {
      for (let i = this.rcLastAckedSeq + 1; i <= frame.ack; i++) this.rcBuffer.delete(i);
      this.rcLastAckedSeq = frame.ack;
    }

    // Bare ack (seq=0) or no payload → done
    if (frame.seq === 0 || !frame.payload) return;

    // Duplicate → ignore
    if (frame.seq <= this.rcInSeq) return;

    // Out-of-order → buffer for later (with cap to prevent unbounded growth)
    if (frame.seq > this.rcInSeq + 1) {
      this.rcPending.set(frame.seq, frame.payload);
      if (this.rcPending.size > DelegateConnection.RC_MAX_PENDING) {
        console.error(`[Connection] rcPending overflow (${this.rcPending.size} frames), disconnecting`);
        this.ws?.close(1008, 'rcPending overflow');
      }
      return;
    }

    // In-order delivery + drain buffered successors
    // H2 fix: wrap each dispatch in try/catch so one bad message doesn't orphan the rest
    this.rcInSeq = frame.seq;
    try {
      this.dispatchMcplPayload(frame.payload);
    } catch (err) {
      console.error(`[Connection] Error dispatching RC frame seq=${frame.seq}:`, err);
    }

    // D-4: Safe drain — avoid non-null assertion on Map.get()
    while (this.rcPending.has(this.rcInSeq + 1)) {
      this.rcInSeq++;
      const payload = this.rcPending.get(this.rcInSeq);
      this.rcPending.delete(this.rcInSeq);
      if (payload) {
        try {
          this.dispatchMcplPayload(payload);
        } catch (err) {
          console.error(`[Connection] Error dispatching RC frame seq=${this.rcInSeq}:`, err);
        }
      }
    }

    this.scheduleBareAck();
  }

  /**
   * Decode an RC payload (JSON-RPC 2.0 or legacy) and dispatch to handleMcplMessage.
   */
  private dispatchMcplPayload(payload: Record<string, unknown>): void {
    if (this.mcplCodec) {
      const decoded = this.mcplCodec.decode(payload);
      if (decoded) {
        this.handleMcplMessage(decoded as any);
        return;
      }
    }
    // Fallback: no codec or codec returned null (legacy/unrecognized)
    this.handleMcplMessage(payload as any);
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
    // DEL-1: Drop stale frames before resending
    const now = Date.now();
    let staleCount = 0;
    for (const [seq, entry] of this.rcBuffer) {
      if (now - entry.ts > DelegateConnection.RC_MAX_BUFFER_AGE) {
        this.rcBuffer.delete(seq);
        staleCount++;
      }
    }
    if (staleCount > 0) {
      console.warn(`[Connection] Dropped ${staleCount} stale RC frame(s) (age > ${DelegateConnection.RC_MAX_BUFFER_AGE}ms)`);
    }

    const toResend = [...this.rcBuffer.entries()]
      .filter(([seq]) => seq > afterSeq)
      .sort(([a], [b]) => a - b);
    for (const [, entry] of toResend) {
      try {
        this.ws?.send(JSON.stringify(entry.frame));
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
        // §10.1: Forward to listeners (hook forwarding pipeline in index.ts).
        // If no listener is registered, send empty response so backend doesn't block forever.
        if (this.listenerCount('mcpl_before_inference') > 0) {
          this.emit('mcpl_before_inference', msg);
        } else {
          // No handler — respond with empty contextInjections
          try {
            this.send({
              type: 'mcpl/beforeInference_response',
              requestId: msg.requestId,
              contextInjections: [],
            });
          } catch { /* ignore */ }
        }
        break;

      case 'mcpl/afterInference':
        // B7 fix: only auto-ack if no listener is handling afterInference.
        // If a listener is registered, it MUST call sendAfterInferenceResponse().
        if (this.listenerCount('mcpl_after_inference') > 0) {
          this.emit('mcpl_after_inference', msg);
        } else {
          // No handler — send simple ack so server doesn't block forever
          try {
            this.send({ type: 'mcpl/afterInference_ack', requestId: msg.requestId });
          } catch { /* ignore */ }
        }
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

      case 'mcpl/push_event_response':
        this.emit('mcpl_push_event_response', msg);
        break;

      case 'mcpl/featureSets_update':
        // §6.6+§6.7: Host sends updated enabled/disabled feature sets
        if (Array.isArray(msg.enabled)) {
          for (const name of msg.enabled) this._enabledFeatureSets.add(name);
        }
        if (Array.isArray(msg.disabled)) {
          for (const name of msg.disabled) this._enabledFeatureSets.delete(name);
        }
        // S1: Store scope policies (§7.2 whitelist/blacklist)
        if (msg.scopes && typeof msg.scopes === 'object') {
          for (const [fsName, scopeRules] of Object.entries(msg.scopes)) {
            this._featureSetScopes[fsName] = scopeRules as { whitelist?: string[]; blacklist?: string[] };
          }
        }
        console.log(`[Connection] featureSets/update: enabled=${JSON.stringify(msg.enabled)}, disabled=${JSON.stringify(msg.disabled)}, scopes=${msg.scopes ? Object.keys(msg.scopes).length : 0}, active=${this._enabledFeatureSets.size}`);
        this.emit('mcpl_featureSets_update', msg);
        break;

      case 'mcpl/featureSets_changed':
        // §6.7: Server notifies host of added/removed feature sets
        this.emit('mcpl_featureSets_changed', msg);
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
   * Send a beforeInference response with context injections (spec Section 10.2).
   */
  sendBeforeInferenceResponse(requestId: string, contextInjections: Array<{
    namespace: string;           // spec: server-defined namespace (was: serverId)
    position: 'system' | 'beforeUser' | 'afterUser';
    content: string | import('./mcpl-types.js').McplContentBlock[];  // B1: multimodal support
    metadata?: Record<string, unknown>;
  }>, featureSet?: string, abort?: boolean, abortReason?: string): void {
    this.send({
      type: 'mcpl/beforeInference_response',
      requestId,
      featureSet,
      contextInjections,
      ...(abort ? { abort: true, abortReason } : {}),
    });
  }

  /**
   * Send an afterInference response with optional modifiedResponse (spec Section 10.5).
   */
  sendAfterInferenceResponse(requestId: string, options?: {
    modifiedResponse?: string;
    featureSet?: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.send({
      type: 'mcpl/afterInference_response',
      requestId,
      ...options,
    });
  }

  /**
   * §6.6: Validate a featureSet name before sending a tagged message.
   * Returns null if OK, or an error object { code, message } if rejected.
   */
  private enforceFeatureSet(featureSet: string): { code: number; message: string } | null {
    // L1: Skip enforcement if featureSets not yet initialized (race window between
    // webhook registration and connected handler). Backend enforces anyway (defense in depth).
    if (this._enabledFeatureSets.size === 0 && Object.keys(this._featureSets).length === 0) {
      return null; // not yet initialized — allow, backend will validate
    }
    const status = this.checkFeatureSet(featureSet);
    if (status === 'enabled') return null;
    if (status === 'disabled') {
      return { code: -32001, message: `Feature set not enabled: ${featureSet}` };
    }
    return { code: -32003, message: `Unknown feature set: ${featureSet}` };
  }

  /**
   * П3: Pre-populate _enabledFeatureSets with locally-known featureSet names.
   * Call after ack, before webhooks can fire. Prevents race where webhook
   * event arrives before connected handler sends featureSets/changed.
   */
  prePopulateFeatureSets(names: string[]): void {
    for (const name of names) {
      if (!this._featureSets[name]) {
        this._featureSets[name] = { uses: [] };
      }
      this._enabledFeatureSets.add(name);
    }
  }

  /**
   * Send a push event to the server.
   * F8a: source → featureSet rename + add origin
   * F8c: push_event is now a request (has requestId, expects response)
   */
  sendPushEvent(event: {
    eventId: string;                       // spec: unique event identifier (was: id)
    featureSet: string;
    origin?: Record<string, unknown>;      // spec: provenance metadata object (was: string)
    conversationId: string;
    eventType: string;
    payload: unknown;
    systemMessage: string;
    idempotencyKey: string;
  }): boolean {
    // §6.6: enforce featureSet before sending
    const rejection = this.enforceFeatureSet(event.featureSet);
    if (rejection) {
      console.warn(`[Connection] Push event rejected: ${rejection.message} (${event.eventId})`);
      return false;  // E1: caller can check and respond appropriately
    }
    this.send({
      type: 'mcpl/push_event',
      requestId: event.eventId,  // F8c: use eventId as requestId for response correlation
      ...event,
      timestamp: new Date().toISOString(),
    });
    console.log(`[Connection] Sent MCPL push event: ${event.featureSet}/${event.eventType} (${event.eventId})`);
    return true;
  }

  /**
   * Send an inference request to the host (MCPL only).
   */
  sendInferenceRequest(request: {
    requestId: string;
    featureSet: string;          // spec: declaring feature set (was: serverId)
    conversationId?: string;     // spec: optional
    stream?: boolean;
    messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
    preferences?: { maxTokens?: number; temperature?: number };  // spec Section 11.2
    systemMessage?: string;
    userMessage?: string;
    parentChainId?: string;
    parentFrameId?: string;
  }): void {
    // P2: enforce featureSet — throw so pending request gets rejected immediately
    const rejection = this.enforceFeatureSet(request.featureSet);
    if (rejection) {
      throw new Error(`Feature set rejected: ${rejection.message} (code: ${rejection.code})`);
    }
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
    featureSet: string;
    scope: { label: string; payload?: Record<string, unknown> };  // spec Section 7.4
    delegateId: string;
    serverId: string;
    conversationId: string;
    requestedCapabilities: string[];
    reason: string;
    timeoutMs?: number;
  }): void {
    // P2: enforce featureSet — throw so caller gets immediate error
    const rejection = this.enforceFeatureSet(request.featureSet);
    if (rejection) {
      throw new Error(`Feature set rejected: ${rejection.message} (code: ${rejection.code})`);
    }
    this.send({
      type: 'mcpl/scope_elevate_request',
      ...request,
    });
    console.log(`[Connection] Sent scope_elevate_request: ${request.featureSet}/${request.scope.label}`);
  }

  /**
   * Send updated featureSets to the server (Phase 7 — Batch 2a).
   * Delta update — only added/removed entries, server merges with existing state.
   * Called when MCP servers are added/removed dynamically at runtime.
   */
  sendFeatureSetsChanged(delta: {
    added?: Record<string, import('./mcpl-types.js').McplFeatureSet>;
    removed?: string[];
  }): void {
    // §6.6: update local featureSet tracking for added/removed
    if (delta.added) {
      for (const name of Object.keys(delta.added)) {
        this._featureSets[name] = delta.added[name];
        this._enabledFeatureSets.add(name); // new featureSets start enabled
      }
    }
    if (delta.removed) {
      for (const name of delta.removed) {
        delete this._featureSets[name];
        this._enabledFeatureSets.delete(name);
      }
    }
    this.send({
      type: 'mcpl/featureSets_changed',
      ...(delta.added ? { added: delta.added } : {}),
      ...(delta.removed ? { removed: delta.removed } : {}),
    });
    console.log(`[Connection] Sent featureSets_changed: added=${Object.keys(delta.added || {}).length}, removed=${(delta.removed || []).length}`);
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
  sendStateRollback(requestId: string, featureSet: string, checkpoint: string): void {
    this.send({
      type: 'mcpl/state_rollback',
      requestId,
      featureSet,
      checkpoint,
    });
    console.log(`[Connection] Sent state_rollback for ${featureSet} checkpoint=${checkpoint}`);
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
  sendModelInfoRequest(requestId: string, conversationId?: string): void {
    this.send({
      type: 'mcpl/model_info_request',
      requestId,
      ...(conversationId ? { conversationId } : {}),
    });
    console.log(`[Connection] Sent model_info_request: ${requestId}${conversationId ? ` (conv: ${conversationId})` : ''}`);
  }

  // --------------------------------------------------------------------------
  // Heartbeat
  // --------------------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pongReceived = true; // DEL-4: reset
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // DEL-4: Check WS-level pong before sending next ping
        if (!this.pongReceived) {
          console.error('[Connection] No WS pong received — terminating dead connection');
          this.ws.terminate();
          return;
        }

        try {
          this.ws.ping(); // DEL-4: WS-level ping for dead connection detection
          // M4 fix: only clear pongReceived AFTER successful ping send
          // prevents false dead-connection detection if ping throws
          this.pongReceived = false;
          // R1 fix: skip app-level ping in MCPL mode — it bypasses RC ordering.
          // WS-level ping above already handles dead connection detection.
          if (!this._isMcpl) {
            this.send({ type: 'ping', timestamp: Date.now() }); // legacy app-level (compat)
          }
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
    // Clear mcplHelloTimeout (may not fire ws close event if socket never fully opened)
    if (this.mcplHelloTimeout) {
      clearTimeout(this.mcplHelloTimeout);
      this.mcplHelloTimeout = null;
    }
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
