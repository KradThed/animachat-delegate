/**
 * MCPL (Model Context Protocol Live) Type Definitions
 *
 * MIRROR of shared/src/mcpl-types.ts from the animachat monorepo.
 * This delegate repo cannot import from the monorepo's shared package,
 * so types are duplicated here. Keep in sync manually for MVP.
 *
 * Later: extract to a published @animachat/mcpl-types package.
 */

// =============================================================================
// Capabilities
// =============================================================================

export type McplCapability =
  | 'context_hooks'
  | 'push_events'
  | 'inference_requests'
  | 'tool_management';

export interface McplFeatureSet {
  contextHooks: boolean;
  pushEvents: boolean;
  inferenceRequests: boolean;
  toolManagement: boolean;
}

// =============================================================================
// Handshake
// =============================================================================

export interface McplHello {
  type: 'mcpl/hello';
  protocolVersion: string;
  capabilities: McplCapability[];
  delegateId: string;
  delegateName: string;
  sessionId?: string;
}

export interface McplAck {
  type: 'mcpl/ack';
  sessionId: string;
  negotiatedCapabilities: McplCapability[];
  featureSets: Record<string, McplFeatureSet>;
}

// =============================================================================
// Context Hooks
// =============================================================================

export interface McplBeforeInferenceRequest {
  type: 'mcpl/beforeInference';
  requestId: string;
  conversationId: string;
  messagesSummary?: string;
}

export interface McplBeforeInferenceResponse {
  type: 'mcpl/beforeInference_response';
  requestId: string;
  injections: McplContextInjection[];
}

export interface McplContextInjection {
  serverId: string;
  position: 'system' | 'beforeUser' | 'afterUser';
  content: string;
}

export interface McplAfterInferenceNotify {
  type: 'mcpl/afterInference';
  requestId: string;
  conversationId: string;
  responseSummary?: string;
}

export interface McplAfterInferenceAck {
  type: 'mcpl/afterInference_ack';
  requestId: string;
}

// =============================================================================
// Push Events
// =============================================================================

export interface McplPushEvent {
  type: 'mcpl/push_event';
  id: string;
  source: string;
  conversationId: string;
  eventType: string;
  payload: unknown;
  systemMessage: string;
  idempotencyKey: string;
  timestamp: string;
}

export interface McplQueueUpdate {
  type: 'mcpl/queue_update';
  conversationId: string;
  queue: McplQueueEntry[];
  totalCount: number;
}

export interface McplQueueEntry {
  id: string;
  source: string;
  eventType: string;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'rate_limited' | 'duplicate_ignored';
  timestamp: string;
  systemMessage: string;
}

// =============================================================================
// Queue Control
// =============================================================================

export interface McplPauseQueue {
  type: 'mcpl/pause_queue';
  conversationId: string;
}

export interface McplResumeQueue {
  type: 'mcpl/resume_queue';
  conversationId: string;
}

// =============================================================================
// Inference Requests
// =============================================================================

export interface McplInferenceRequest {
  type: 'mcpl/inference_request';
  requestId: string;
  serverId: string;
  conversationId: string;
  systemMessage?: string;
  userMessage: string;
  maxTokens?: number;
  stream?: boolean;            // Phase 7 Batch 5: request streaming response
  parentChainId?: string;      // Fix #5: chain tracking for recursion prevention
  parentFrameId?: string;      // Fix #5: frame tracking for recursion prevention
}

export interface McplInferenceResponse {
  type: 'mcpl/inference_response';
  requestId: string;
  success: boolean;
  content?: string;            // full text (for non-streaming, or verification for streaming)
  error?: string;
}

/** Server → Delegate: streaming inference chunk (Phase 7 — Batch 5).
 *  NO done field — completion is signaled by mcpl/inference_response. */
export interface McplInferenceChunk {
  type: 'mcpl/inference_chunk';
  requestId: string;
  chunkIndex: number;        // sequential from 0
  delta: string;             // text delta
}

// =============================================================================
// Scope Change
// =============================================================================

export interface McplScopeChangeRequest {
  type: 'mcpl/scope_change_request';
  requestId: string;
  serverId: string;
  conversationId: string;
  url: string;
  serverName: string;
  requestedCapabilities: McplCapability[];
  reason: string;
}

export interface McplScopeChangeApprovalNeeded {
  type: 'mcpl/scope_change_approval_needed';
  requestId: string;
  conversationId: string;
  delegateId: string;
  delegateName: string;
  requestedCapabilities: {
    servers: Array<{ url: string; name: string; reason: string }>;
  };
  timeout: number;
}

export interface McplScopeChangeDecision {
  type: 'mcpl/scope_change_approved' | 'mcpl/scope_change_denied';
  requestId: string;
}

export interface McplScopeChangeResult {
  type: 'mcpl/scope_change_result';
  requestId: string;
  approved: boolean;
  newCapabilities?: McplCapability[];
}

// =============================================================================
// Connect Server (message type only, NOT a tool)
// =============================================================================

export interface McplConnectServer {
  type: 'mcpl/connect_server';
  url: string;
  serverName?: string;
}

// =============================================================================
// Connect Server Result (Phase 6d)
// =============================================================================

/** Delegate → Server: outcome of addServer() after scope change approval */
export interface McplConnectServerResult {
  type: 'mcpl/connect_server_result';
  requestId: string;
  url: string;
  success: boolean;
  serverId?: string;
  tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  error?: string;
}

/** Terminal statuses for scope change requests */
export type ScopeChangeStatus =
  | 'denied_by_user'
  | 'denied_by_timeout'
  | 'approved_connected'
  | 'approved_failed';

// =============================================================================
// Event Store Types (schema-free JSONL — these are the contract)
// =============================================================================

export interface McplServerEnabledChangedEvent {
  serverId: string;
  delegateId: string;
  enabled: boolean;
  source: 'agent' | 'user';
}

export interface McplPushEventReceivedEvent {
  id: string;
  source: string;
  eventType: string;
  status: string;
}

export interface McplPushEventProcessedEvent {
  id: string;
  success: boolean;
  error?: string;
}

export interface McplInferenceRequestCompletedEvent {
  requestId: string;
  serverId: string;
  timestamp: string;
}

export interface McplScopeChangeResolvedEvent {
  requestId: string;
  delegateId: string;
  serverId: string;
  status: ScopeChangeStatus;
  url?: string;
  error?: string;
}

// =============================================================================
// Scope Elevate (Phase 7 — Batch 4)
// =============================================================================

/** Delegate → Server: MCP server requests capability elevation mid-operation */
export interface McplScopeElevateRequest {
  type: 'mcpl/scope_elevate_request';
  requestId: string;
  delegateId: string;
  serverId: string;
  conversationId: string;
  featureSet: string;
  label: string;
  requestedCapabilities: McplCapability[];
  reason: string;
  timeoutMs?: number;
}

/** Server → Delegate: scope elevate result */
export interface McplScopeElevateResult {
  type: 'mcpl/scope_elevate_result';
  requestId: string;
  approved: boolean;
  newCapabilities?: McplCapability[];
}

/** Scope context attached to tool calls for MCP server awareness */
export interface McplScopeContext {
  featureSet: string;
  activeCapabilities: McplCapability[];
}

// =============================================================================
// Feature Sets Changed (Phase 7 — Batch 2a)
// =============================================================================

/** Delegate → Server: dynamic featureSet update (full replacement, server computes diff).
 *  Use case: delegate reconnects or changes its MCP servers at runtime.
 *  Server diffs against previous featureSets — removed keys → auto-disable servers. */
export interface McplFeatureSetsChanged {
  type: 'mcpl/featureSets_changed';
  featureSets: Record<string, McplFeatureSet>;  // full replacement, server computes diff
}

// =============================================================================
// State Management (Phase 7 — Batch 2b)
// =============================================================================

/** Delegate → Server: set (replace) conversation state */
export interface McplStateSet {
  type: 'mcpl/state_set';
  requestId: string;
  conversationId: string;
  state: Record<string, unknown>;
}

/** Delegate → Server: apply JSON Patch (RFC 6902) to conversation state */
export interface McplStatePatch {
  type: 'mcpl/state_patch';
  requestId: string;
  conversationId: string;
  patch: unknown[];
}

/** Server → Delegate: result of state_patch */
export interface McplStatePatchResult {
  type: 'mcpl/state_patch_result';
  requestId: string;
  success: boolean;
  error?: string;
}

/** Delegate → Server: rollback to checkpoint (Phase 8: optional target) */
export interface McplStateRollback {
  type: 'mcpl/state_rollback';
  requestId: string;
  conversationId: string;
  checkpointId?: string;    // Phase 8: target checkpoint (omit = parent of current)
}

/** Delegate → Server: get current state */
export interface McplStateGet {
  type: 'mcpl/state_get';
  requestId: string;
  conversationId: string;
}

/** Server → Delegate: current state response */
export interface McplStateResponse {
  type: 'mcpl/state_response';
  requestId: string;
  state: Record<string, unknown> | null;
  rolledBack?: boolean;
  checkpointId?: string;    // Phase 8: which checkpoint was rolled back to
  error?: 'checkpoint_expired' | 'checkpoint_unknown' | 'no_checkpoints' | 'rollback_failed' | 'rollback_denied';
}

// =============================================================================
// Checkpoint List (Phase 8)
// =============================================================================

/** Delegate → Server: query checkpoint tree */
export interface McplCheckpointList {
  type: 'mcpl/checkpoint_list';
  requestId: string;
  conversationId: string;
}

/** Server → Delegate: checkpoint tree structure */
export interface McplCheckpointListResponse {
  type: 'mcpl/checkpoint_list_response';
  requestId: string;
  current: string;
  checkpoints: Array<{
    id: string;
    parent: string | null;
    children: string[];
    createdAt: number;
    isCurrent: boolean;
    label?: string;
    mutationCount?: number;
  }>;
}

// =============================================================================
// Model Info (Phase 7 — Batch 1b)
// =============================================================================

/** Maps to spec's model/info (Section 12) JSON-RPC method.
 *  Uses MCPL message framing for consistency with other delegate↔backend messages. */
export interface McplModelInfoRequest {
  type: 'mcpl/model_info_request';
  requestId: string;
  // no modelId — backend resolves from conversation context
}

export interface McplModelInfoResponse {
  type: 'mcpl/model_info_response';
  requestId: string;
  modelId: string;
  provider: string;
  contextWindow: number;
  outputTokenLimit: number;
  supportsThinking: boolean;
  supportsPrefill: boolean;
  capabilities: {
    imageInput: boolean;
    pdfInput: boolean;
    audioInput: boolean;
    videoInput: boolean;
    imageOutput: boolean;
    audioOutput: boolean;
  };
}
