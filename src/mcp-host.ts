/**
 * MCP Host Manager
 *
 * Spawns and manages MCP server subprocesses via stdio transport.
 * Collects tool definitions from all servers and routes tool calls.
 *
 * Phase 3: Deterministic duplicate detection (sorted server order, first-wins).
 * Phase 7: Virtual _scope_elevate tool for capability elevation requests.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { McpServerConfig, ToolDefinition } from './types.js';

// =============================================================================
// Helpers
// =============================================================================

/**
 * S-5 fix: Allowlist of environment variables safe to pass to child MCP servers.
 * Only these + config.env are forwarded. Everything else (API keys, tokens,
 * database URLs) is stripped to prevent secret leakage to untrusted servers.
 */
const SAFE_ENV_VARS = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'COLORTERM', 'EDITOR',
  'TMPDIR', 'TMP', 'TEMP',
  'NODE_ENV', 'NODE_PATH', 'NODE_OPTIONS',
  'SYSTEMROOT', 'COMSPEC', 'WINDIR',     // Windows essentials
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES',
  'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'OS', 'SYSTEMDRIVE',
];

function getSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_ENV_VARS) {
    const val = process.env[key];
    if (val !== undefined) safe[key] = val;
  }
  return safe;
}

/** Race a promise against a timeout. Rejects with TimeoutError on expiry. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// =============================================================================
// Types
// =============================================================================

/** Hook capabilities advertised by an MCP server via experimental.mcpl */
export interface McpHookCapabilities {
  beforeInference?: boolean;
  afterInference?: boolean | { blocking?: boolean };
}

/** Parsed MCPL capabilities from a server's experimental.mcpl declaration */
export interface McpServerMcplCaps {
  hooks?: McpHookCapabilities;
  pushEvents?: boolean;
  inferenceRequest?: boolean;
  scoped?: boolean;
  rollback?: boolean;
  channels?: { publish?: boolean; observe?: boolean };
}

interface McpServer {
  name: string;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: ToolDefinition[];
  /** §10: Hook capabilities parsed from server's MCP initialize result */
  mcplHooks?: McpHookCapabilities;
  /** All MCPL capabilities parsed from server's experimental.mcpl */
  mcplCaps?: McpServerMcplCaps;
}

export interface DuplicateToolWarning {
  toolName: string;
  fromServer: string;
  conflictsWith: string;
}

// =============================================================================
// Virtual Tools
// =============================================================================

/** Virtual tool injected into tool list so MCP servers can request capability elevation */
const SCOPE_ELEVATE_TOOL: ToolDefinition = {
  name: '_scope_elevate',
  description: 'Request scope elevation per spec §7.4. Returns { approved: boolean, payload?: object, reason?: string }.',
  inputSchema: {
    type: 'object',
    properties: {
      featureSet: { type: 'string', description: 'Feature set to elevate (spec §7.4)' },
      label: { type: 'string', description: 'Human-readable scope label for whitelist/blacklist matching' },
      payload: { type: 'object', description: 'Arbitrary data passed back to server when approved (spec §7.3)' },
      reason: { type: 'string', description: 'Why elevation is needed' },
    },
    required: ['featureSet', 'label'],
  },
};

// ---------------------------------------------------------------------------
// MCP Management Virtual Tools
// ---------------------------------------------------------------------------

const MCP_LIST_SERVERS_TOOL: ToolDefinition = {
  name: '_mcp_list_servers',
  description: 'List all configured MCP servers, their running status, and available tools.',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const MCP_ENABLE_SERVER_TOOL: ToolDefinition = {
  name: '_mcp_enable_server',
  description: 'Start a stopped MCP server by name (must exist in delegate config).',
  inputSchema: {
    type: 'object',
    properties: {
      serverName: { type: 'string', description: 'Name of the MCP server from config' },
    },
    required: ['serverName'],
  },
};

const MCP_DISABLE_SERVER_TOOL: ToolDefinition = {
  name: '_mcp_disable_server',
  description: 'Stop a running MCP server by name.',
  inputSchema: {
    type: 'object',
    properties: {
      serverName: { type: 'string', description: 'Name of the MCP server to stop' },
    },
    required: ['serverName'],
  },
};

const MCP_RESTART_SERVER_TOOL: ToolDefinition = {
  name: '_mcp_restart_server',
  description: 'Stop and restart an MCP server by name. Useful after config or environment changes.',
  inputSchema: {
    type: 'object',
    properties: {
      serverName: { type: 'string', description: 'Name of the MCP server to restart' },
    },
    required: ['serverName'],
  },
};

const MCP_MANAGEMENT_TOOLS = [
  MCP_LIST_SERVERS_TOOL,
  MCP_ENABLE_SERVER_TOOL,
  MCP_DISABLE_SERVER_TOOL,
  MCP_RESTART_SERVER_TOOL,
];

// ---------------------------------------------------------------------------
// MCPL Proxy Virtual Tools — let MCP servers access MCPL features via backend
// ---------------------------------------------------------------------------

/** §11: Request inference from the host (forwarded to backend) */
const MCPL_INFERENCE_REQUEST_TOOL: ToolDefinition = {
  name: '_mcpl_inference_request',
  description: 'Request autonomous inference from the host (spec §11). Returns model response.',
  inputSchema: {
    type: 'object',
    properties: {
      featureSet: { type: 'string', description: 'Declaring feature set' },
      conversationId: { type: 'string', description: 'Associate with conversation (optional)' },
      stream: { type: 'boolean', description: 'Stream response (default: false)' },
      messages: {
        type: 'array',
        description: 'Messages for inference',
        items: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'string' },
          },
          required: ['role', 'content'],
        },
      },
      maxTokens: { type: 'number', description: 'Max output tokens' },
      temperature: { type: 'number', description: 'Sampling temperature' },
    },
    required: ['featureSet', 'messages'],
  },
};

/** §8: Get state for a feature set / conversation */
const MCPL_STATE_GET_TOOL: ToolDefinition = {
  name: '_mcpl_state_get',
  description: 'Get persisted state from the host (spec §8). Returns state data.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'Conversation to get state for' },
    },
    required: ['conversationId'],
  },
};

/** §8: Patch state via JSON Patch (RFC 6902) */
const MCPL_STATE_PATCH_TOOL: ToolDefinition = {
  name: '_mcpl_state_patch',
  description: 'Apply JSON Patch (RFC 6902) to persisted state (spec §8). Returns patch result.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'Conversation to patch state for' },
      patch: {
        type: 'array',
        description: 'JSON Patch operations (RFC 6902)',
        items: { type: 'object' },
      },
    },
    required: ['conversationId', 'patch'],
  },
};

/** §8: Rollback state to a previous checkpoint */
const MCPL_STATE_ROLLBACK_TOOL: ToolDefinition = {
  name: '_mcpl_state_rollback',
  description: 'Rollback state to a previous checkpoint (spec §8.5). Returns rollback result.',
  inputSchema: {
    type: 'object',
    properties: {
      featureSet: { type: 'string', description: 'Feature set to rollback' },
      checkpoint: { type: 'string', description: 'Checkpoint ID to rollback to' },
    },
    required: ['featureSet', 'checkpoint'],
  },
};

/** §8: List checkpoints for a conversation */
const MCPL_CHECKPOINT_LIST_TOOL: ToolDefinition = {
  name: '_mcpl_checkpoint_list',
  description: 'List state checkpoints for a conversation (spec §8.7). Returns checkpoint tree.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'Conversation to list checkpoints for' },
    },
    required: ['conversationId'],
  },
};

/** §12: Get model info from the host */
const MCPL_MODEL_INFO_TOOL: ToolDefinition = {
  name: '_mcpl_model_info',
  description: 'Get current model metadata from the host (spec §12). Returns id, vendor, contextWindow, capabilities.',
  inputSchema: {
    type: 'object',
    properties: {
      conversationId: { type: 'string', description: 'Optional: resolve model for a specific conversation instead of the default' },
    },
  },
};

const MCPL_PROXY_TOOLS = [
  MCPL_INFERENCE_REQUEST_TOOL,
  MCPL_STATE_GET_TOOL,
  MCPL_STATE_PATCH_TOOL,
  MCPL_STATE_ROLLBACK_TOOL,
  MCPL_CHECKPOINT_LIST_TOOL,
  MCPL_MODEL_INFO_TOOL,
];

// =============================================================================
// McpHostManager
// =============================================================================

export class McpHostManager {
  private servers: Map<string, McpServer> = new Map();
  /** B4: Public read-only access to servers for featureSets/update forwarding */
  get allServers(): ReadonlyMap<string, McpServer> { return this.servers; }
  private toolToServer: Map<string, string> = new Map();
  private _duplicateWarnings: DuplicateToolWarning[] = [];
  private scopeElevateHandler?: (input: Record<string, unknown>) => Promise<{ approved: boolean; payload?: Record<string, unknown>; reason?: string }>;

  /** MCPL proxy handler: forwards requests to backend via connection */
  private mcplProxyHandler?: (method: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

  /** Whether MCPL proxy tools should be included (true when connection is MCPL) */
  private mcplEnabled = false;

  /** MCP server configs from delegate.yaml (set by setMcpConfigs, used for enable/restart) */
  private mcpConfigs: McpServerConfig[] = [];

  /** C-2 fix: true during stopAll() — onclose handlers skip crash notifications */
  private stopping = false;

  /** Callback when toolset changes (enable/disable/restart/crash) — used for manifest re-send + events */
  onToolsetChanged?: (reason: string, serverName: string) => void;

  /** DEL-12: Callback when an MCP server process dies unexpectedly */
  onServerDied?: (serverName: string) => void;

  /**
   * Get the tool name → server name mapping (read-only).
   * Used by TelemetryBus to resolve server names for tool calls.
   */
  getToolServerMap(): ReadonlyMap<string, string> {
    return this.toolToServer;
  }

  /**
   * Set the handler for _scope_elevate virtual tool calls.
   * Called from index.ts after connection is established.
   */
  setScopeElevateHandler(handler: (input: Record<string, unknown>) => Promise<{ approved: boolean; payload?: Record<string, unknown>; reason?: string }>): void {
    this.scopeElevateHandler = handler;
  }

  /**
   * Set the MCPL proxy handler for forwarding requests to the backend.
   * Called from index.ts after connection is established.
   * The handler takes a method name and input, forwards to backend, returns response.
   */
  setMcplProxyHandler(handler: (method: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>): void {
    this.mcplProxyHandler = handler;
    this.mcplEnabled = true;
  }

  /**
   * Store MCP server configs for enable/restart virtual tools.
   * Called from index.ts after config load (and on reload).
   */
  setMcpConfigs(configs: McpServerConfig[]): void {
    this.mcpConfigs = configs;
  }

  /**
   * Spawn all configured MCP servers and collect their tools.
   * Individual server failures are logged but don't prevent others from starting.
   */
  async startAll(configs: McpServerConfig[]): Promise<void> {
    if (configs.length === 0) {
      console.log('[McpHost] No MCP servers configured');
      return;
    }

    console.log(`[McpHost] Starting ${configs.length} MCP server(s)...`);

    const results = await Promise.allSettled(
      configs.map(config => this.spawnServer(config))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const config = configs[i];
      if (result.status === 'rejected') {
        console.error(`[McpHost] Failed to start "${config.name}":`, result.reason);
      }
    }

    // Rebuild tool list in deterministic sorted order after all servers are up
    this.rebuildToolList();

    const started = [...this.servers.values()];
    const totalTools = started.reduce((sum, s) => sum + s.tools.length, 0);
    console.log(
      `[McpHost] ${started.length}/${configs.length} servers started, ${totalTools} tools available`
    );

    if (this._duplicateWarnings.length > 0) {
      console.warn(`[McpHost] ${this._duplicateWarnings.length} duplicate tool(s) detected (first-wins, duplicates skipped)`);
    }
  }

  /**
   * Stop all running MCP servers gracefully.
   */
  async stopAll(): Promise<void> {
    if (this.servers.size === 0) return;

    // C-2 fix: Suppress false crash notifications during graceful shutdown
    this.stopping = true;
    console.log(`[McpHost] Stopping ${this.servers.size} MCP server(s)...`);

    await Promise.allSettled(
      [...this.servers.values()].map(async (server) => {
        try {
          await server.client.close();
          console.log(`[McpHost] Stopped "${server.name}"`);
        } catch (error) {
          console.warn(`[McpHost] Error stopping "${server.name}":`, error);
        }
      })
    );

    this.servers.clear();
    this.toolToServer.clear();
    this._duplicateWarnings = [];
    this.stopping = false;  // B2 fix: re-enable crash detection after shutdown
  }

  /**
   * Get all tools aggregated from all running MCP servers.
   */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const server of this.servers.values()) {
      tools.push(...server.tools);
    }
    return tools;
  }

  /**
   * Get all tools with serverName attached to each tool.
   * Used for tool manifests so the server can track tool origin.
   * Includes virtual _scope_elevate tool if handler is set.
   */
  getAllToolsWithServer(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    // Use toolToServer map (populated by rebuildToolList in deterministic order)
    // Only includes non-duplicate tools
    for (const [toolName, serverName] of this.toolToServer) {
      const server = this.servers.get(serverName);
      if (!server) continue;
      const tool = server.tools.find(t => t.name === toolName);
      if (tool) {
        tools.push({ ...tool, serverName, featureSet: serverName });
      }
    }
    // Append virtual tools (no serverName — delegate-internal)
    if (this.scopeElevateHandler) {
      tools.push(SCOPE_ELEVATE_TOOL);
    }
    // MCP management tools always available
    tools.push(...MCP_MANAGEMENT_TOOLS);
    // MCPL proxy tools (only when connected via MCPL)
    if (this.mcplEnabled) {
      tools.push(...MCPL_PROXY_TOOLS);
    }
    return tools;
  }

  /**
   * Get duplicate warnings from the last tool collection.
   */
  getDuplicateWarnings(): DuplicateToolWarning[] {
    return this._duplicateWarnings;
  }

  /**
   * §10.6: Get servers that support beforeInference hooks.
   * Returns { name, client } pairs for forwarding.
   */
  getBeforeInferenceServers(): Array<{ name: string; client: Client }> {
    const result: Array<{ name: string; client: Client }> = [];
    for (const server of this.servers.values()) {
      if (server.mcplHooks?.beforeInference) {
        result.push({ name: server.name, client: server.client });
      }
    }
    return result;
  }

  /**
   * §10.5: Get servers that support afterInference hooks.
   * Returns { name, client, blocking } for forwarding.
   */
  getAfterInferenceServers(): Array<{ name: string; client: Client; blocking: boolean }> {
    const result: Array<{ name: string; client: Client; blocking: boolean }> = [];
    for (const server of this.servers.values()) {
      if (server.mcplHooks?.afterInference) {
        const blocking = typeof server.mcplHooks.afterInference === 'object'
          ? server.mcplHooks.afterInference.blocking === true
          : false;
        result.push({ name: server.name, client: server.client, blocking });
      }
    }
    return result;
  }

  /**
   * §6.1: Build featureSets Record from active MCP servers.
   * Each server name becomes a featureSet key, `uses` lists what the server supports.
   */
  buildFeatureSets(): Record<string, import('./mcpl-types.js').McplFeatureSet> {
    const featureSets: Record<string, import('./mcpl-types.js').McplFeatureSet> = {};
    for (const server of this.servers.values()) {
      const caps = server.mcplCaps;
      const uses: string[] = ['tools']; // every server provides tools
      // Bug 5: Include all capabilities in uses
      if (caps?.hooks?.beforeInference) uses.push('contextHooks.beforeInference');
      if (caps?.hooks?.afterInference) uses.push('contextHooks.afterInference');
      if (caps?.pushEvents) uses.push('pushEvents');
      if (caps?.inferenceRequest) uses.push('inferenceRequest');
      if (caps?.channels?.publish) uses.push('channels.publish');
      if (caps?.channels?.observe) uses.push('channels.observe');
      // Fallback: check mcplHooks if mcplCaps not parsed yet
      if (!caps && server.mcplHooks?.beforeInference) uses.push('contextHooks.beforeInference');
      if (!caps && server.mcplHooks?.afterInference) uses.push('contextHooks.afterInference');

      const fs: import('./mcpl-types.js').McplFeatureSet = {
        description: `MCP server: ${server.name}`,
        uses,
      };
      // Bug 1: Forward scoped/rollback from server declarations
      if (caps?.scoped) fs.scoped = true;
      if (caps?.rollback) fs.rollback = true;
      featureSets[server.name] = fs;
    }
    return featureSets;
  }

  /**
   * Call a tool by name, routing to the correct MCP server.
   * Intercepts virtual _scope_elevate tool before MCP server routing.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    mcplExtras?: {
      state?: Record<string, unknown> | null;
      checkpoint?: string;
      scope?: { label: string; payload?: Record<string, unknown> };
    },
  ): Promise<{ content: string; isError: boolean }> {
    // Intercept virtual _scope_elevate tool
    // L1 fix: explicit error when handler not set (prevents fall-through to "Unknown tool")
    if (name === '_scope_elevate') {
      if (!this.scopeElevateHandler) {
        return { content: 'Scope elevate handler not configured', isError: true };
      }
      try {
        const result = await this.scopeElevateHandler(args);
        return { content: JSON.stringify(result), isError: false };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: `Scope elevate failed: ${msg}`, isError: true };
      }
    }

    // Intercept MCP management virtual tools
    if (name === '_mcp_list_servers') {
      return this.handleMcpListServers();
    }
    if (name === '_mcp_enable_server') {
      return this.handleMcpEnableServer(String(args.serverName || ''));
    }
    if (name === '_mcp_disable_server') {
      return this.handleMcpDisableServer(String(args.serverName || ''));
    }
    if (name === '_mcp_restart_server') {
      return this.handleMcpRestartServer(String(args.serverName || ''));
    }

    // Intercept MCPL proxy virtual tools
    if (name.startsWith('_mcpl_')) {
      return this.handleMcplProxy(name, args);
    }

    const serverName = this.toolToServer.get(name);
    if (!serverName) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }

    const server = this.servers.get(serverName);
    if (!server) {
      return { content: `MCP server "${serverName}" is not running`, isError: true };
    }

    try {
      const result = await withTimeout(
        server.client.callTool({
          name,
          arguments: args,
          // B6: forward MCPL state/checkpoint/scope per spec Section 8.4 / 7.7
          ...(mcplExtras?.state != null ? { state: mcplExtras.state } : {}),
          ...(mcplExtras?.checkpoint ? { checkpoint: mcplExtras.checkpoint } : {}),
          ...(mcplExtras?.scope ? { scope: mcplExtras.scope } : {}),
        } as any),
        300_000,
        `callTool(${name})`
      );

      // Extract text content from the result
      const textParts: string[] = [];
      if (Array.isArray(result.content)) {
        for (const block of result.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            textParts.push(block.text);
          } else if (block.type === 'image') {
            textParts.push('[image]');
          } else if (block.type === 'resource') {
            textParts.push(`[resource: ${(block as any).uri || 'unknown'}]`);
          }
        }
      }

      return {
        content: textParts.join('\n') || '(empty result)',
        isError: result.isError === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[McpHost] Tool call "${name}" failed:`, message);
      return { content: `Tool execution error: ${message}`, isError: true };
    }
  }

  // --------------------------------------------------------------------------
  // MCP Management Virtual Tool Handlers
  // --------------------------------------------------------------------------

  private handleMcpListServers(): { content: string; isError: boolean } {
    try {
      const configuredNames = new Set(this.mcpConfigs.map(c => c.name));
      const result = this.mcpConfigs.map(cfg => {
        const server = this.servers.get(cfg.name);
        return {
          name: cfg.name,
          status: server ? 'running' : 'stopped',
          toolCount: server ? server.tools.length : 0,
          tools: server ? server.tools.map(t => t.name) : [],
          acceptsMcplContext: cfg.acceptsMcplContext,
        };
      });

      // Also include dynamic servers (added via SSE, not in config)
      for (const [name, server] of this.servers) {
        if (!configuredNames.has(name)) {
          result.push({
            name,
            status: 'running',
            toolCount: server.tools.length,
            tools: server.tools.map(t => t.name),
            acceptsMcplContext: false,
          });
        }
      }

      return { content: JSON.stringify(result, null, 2), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `List servers failed: ${msg}`, isError: true };
    }
  }

  private async handleMcpEnableServer(serverName: string): Promise<{ content: string; isError: boolean }> {
    if (!serverName) {
      return { content: 'Missing required parameter: serverName', isError: true };
    }

    // Check if already running
    if (this.servers.has(serverName)) {
      const server = this.servers.get(serverName)!;
      return {
        content: JSON.stringify({
          status: 'already_running',
          serverName,
          toolCount: server.tools.length,
          tools: server.tools.map(t => t.name),
        }),
        isError: false,
      };
    }

    // Find in config
    const cfg = this.mcpConfigs.find(c => c.name === serverName);
    if (!cfg) {
      return { content: `Server "${serverName}" not found in config`, isError: true };
    }

    try {
      await this.spawnServer(cfg);
      this.rebuildToolList();
      const server = this.servers.get(serverName);
      const result = {
        status: 'started',
        serverName,
        toolCount: server?.tools.length || 0,
        tools: server?.tools.map(t => t.name) || [],
      };
      console.log(`[McpHost] Server "${serverName}" enabled via _mcp_enable_server`);
      this.onToolsetChanged?.('server_enabled', serverName);
      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Enable server "${serverName}" failed: ${msg}`, isError: true };
    }
  }

  private async handleMcpDisableServer(serverName: string): Promise<{ content: string; isError: boolean }> {
    if (!serverName) {
      return { content: 'Missing required parameter: serverName', isError: true };
    }

    const server = this.servers.get(serverName);
    if (!server) {
      return { content: `Server "${serverName}" is not running`, isError: true };
    }

    try {
      await server.client.close();
      this.servers.delete(serverName);
      this.rebuildToolList();
      console.log(`[McpHost] Server "${serverName}" disabled via _mcp_disable_server`);
      this.onToolsetChanged?.('server_disabled', serverName);
      return {
        content: JSON.stringify({ status: 'stopped', serverName }),
        isError: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Disable server "${serverName}" failed: ${msg}`, isError: true };
    }
  }

  private async handleMcpRestartServer(serverName: string): Promise<{ content: string; isError: boolean }> {
    if (!serverName) {
      return { content: 'Missing required parameter: serverName', isError: true };
    }

    const cfg = this.mcpConfigs.find(c => c.name === serverName);
    if (!cfg) {
      return { content: `Server "${serverName}" not found in config`, isError: true };
    }

    try {
      // Stop if running
      const existingServer = this.servers.get(serverName);
      if (existingServer) {
        await existingServer.client.close();
        this.servers.delete(serverName);
        // Stale toolToServer fix: rebuild immediately so entries don't point to deleted server
        this.rebuildToolList();
      }

      // Start
      await this.spawnServer(cfg);
      this.rebuildToolList();
      const server = this.servers.get(serverName);
      const result = {
        status: 'restarted',
        serverName,
        toolCount: server?.tools.length || 0,
        tools: server?.tools.map(t => t.name) || [],
      };
      console.log(`[McpHost] Server "${serverName}" restarted via _mcp_restart_server`);
      this.onToolsetChanged?.('server_restarted', serverName);
      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Restart server "${serverName}" failed: ${msg}`, isError: true };
    }
  }

  // ---------------------------------------------------------------------------
  // MCPL Proxy handler — forwards _mcpl_* virtual tool calls to backend
  // ---------------------------------------------------------------------------

  private async handleMcplProxy(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    if (!this.mcplProxyHandler) {
      return { content: 'MCPL proxy not available (connection is not MCPL)', isError: true };
    }

    try {
      const result = await this.mcplProxyHandler(name, args);
      return { content: JSON.stringify(result), isError: false };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `MCPL proxy ${name} failed: ${msg}`, isError: true };
    }
  }

  /**
   * Rebuild the tool-to-server mapping in deterministic sorted order.
   * First-wins on duplicates. Populates _duplicateWarnings.
   */
  rebuildToolList(): void {
    this.toolToServer.clear();
    this._duplicateWarnings = [];

    // Sort servers by name for deterministic order
    const sorted = [...this.servers.values()].sort((a, b) => a.name.localeCompare(b.name));

    for (const server of sorted) {
      for (const tool of server.tools) {
        if (this.toolToServer.has(tool.name)) {
          const existing = this.toolToServer.get(tool.name)!;
          console.error(
            `[McpHost] DUPLICATE: "${tool.name}" from "${server.name}" conflicts with "${existing}" (skipped)`
          );
          this._duplicateWarnings.push({
            toolName: tool.name,
            fromServer: server.name,
            conflictsWith: existing,
          });
          continue; // SKIP duplicate (first-wins, deterministic)
        }
        this.toolToServer.set(tool.name, server.name);
      }
    }
  }

  /**
   * Dynamically add a new MCP server by URL (SSE transport).
   * Used for scope change — when a delegate requests a new server connection.
   */
  async addServer(url: string, serverName?: string): Promise<{ tools: ToolDefinition[] }> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    const name = serverName ?? parsedUrl.hostname;
    if (this.servers.has(name)) {
      throw new Error(`Server "${name}" already exists`);
    }

    // F2 fix: Dynamic SSE servers get MCPL capabilities by default
    const client = new Client(
      { name: `animachat-delegate:${name}`, version: '1.0.0' },
      { capabilities: { experimental: { mcpl: { protocolVersion: '0.4.1-draft' } } } }
    );

    const transport = new SSEClientTransport(parsedUrl);
    await withTimeout(client.connect(transport), 30_000, `connect(SSE:${name})`);

    // DEL-14: Detect SSE server connection loss (must be after connect())
    client.onclose = () => {
      // C-2 fix: Don't fire crash notifications during graceful stopAll()
      if (this.stopping) return;
      if (this.servers.has(name)) {
        console.error(`[McpHost] Dynamic server "${name}" disconnected`);
        this.servers.delete(name);
        this.rebuildToolList();
        this.onServerDied?.(name);
      }
    };
    client.onerror = (error) => {
      console.error(`[McpHost] Dynamic server "${name}" error: ${error.message}`);
    };

    const mcplCaps = this.parseMcplCapabilities(client);
    const mcplHooks = mcplCaps?.hooks;
    const server: McpServer = { name, client, transport, tools: [], mcplHooks, mcplCaps };
    await this.collectTools(server);
    this.servers.set(name, server);
    this.rebuildToolList();

    console.log(`[McpHost] Dynamic server "${name}" added via SSE (${server.tools.length} tools)`);
    return { tools: server.tools };
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async spawnServer(config: McpServerConfig): Promise<void> {
    console.log(`[McpHost] Starting "${config.name}" (${config.command} ${config.args.join(' ')})...`);

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // S-5 fix: Only pass safe env vars + explicit config.env to child processes.
      // Prevents leaking API keys, tokens, database URLs to untrusted MCP servers.
      // BUG-12 fix: filter out undefined values.
      env: Object.fromEntries(
        Object.entries({ ...getSafeEnv(), ...(config.env || {}) })
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
      ),
    });

    // F2 fix: Advertise MCPL support via experimental.mcpl if server accepts MCPL context
    const capabilities = config.acceptsMcplContext
      ? { experimental: { mcpl: { protocolVersion: '0.4.1-draft' } } }
      : {};
    const client = new Client(
      { name: `animachat-delegate:${config.name}`, version: '1.0.0' },
      { capabilities }
    );

    await withTimeout(client.connect(transport), 30_000, `connect(stdio:${config.name})`);

    // DEL-12: Detect MCP server crash/exit (must be set AFTER connect() which replaces callbacks)
    const serverName = config.name;
    client.onclose = () => {
      // C-2 fix: Don't fire crash notifications during graceful stopAll()
      if (this.stopping) return;
      if (this.servers.has(serverName)) {
        console.error(`[McpHost] Server "${serverName}" process exited unexpectedly`);
        this.servers.delete(serverName);
        this.rebuildToolList();
        this.onServerDied?.(serverName);
      }
    };
    client.onerror = (error) => {
      console.error(`[McpHost] Server "${serverName}" error: ${error.message}`);
    };

    // §10: Parse MCPL capabilities from server's initialize result
    const mcplCaps = this.parseMcplCapabilities(client);
    const mcplHooks = mcplCaps?.hooks;

    const server: McpServer = {
      name: config.name,
      client,
      transport,
      tools: [],
      mcplHooks,
      mcplCaps,
    };

    // Collect tools from this server
    await this.collectTools(server);

    this.servers.set(config.name, server);
    const hookDesc = mcplHooks ? ` hooks=[${mcplHooks.beforeInference ? 'before' : ''}${mcplHooks.afterInference ? (mcplHooks.beforeInference ? ',' : '') + 'after' : ''}]` : '';
    console.log(`[McpHost] "${config.name}" started with ${server.tools.length} tools${hookDesc}`);
  }

  /**
   * §10: Parse MCPL hook capabilities from server's initializeResult.
   * Looks in `experimental.mcpl.contextHooks` per spec §5.2.
   * Returns undefined if server doesn't advertise any hooks.
   */
  private parseHookCapabilities(client: Client): McpHookCapabilities | undefined {
    const mcplCaps = this.parseMcplCapabilities(client);
    return mcplCaps?.hooks;
  }

  /** Parse all MCPL capabilities from server's experimental.mcpl declaration */
  private parseMcplCapabilities(client: Client): McpServerMcplCaps | undefined {
    const caps = client.getServerCapabilities();
    if (!caps) return undefined;
    const experimental = (caps as any).experimental;
    if (!experimental?.mcpl) return undefined;
    const mcpl = experimental.mcpl;

    const result: McpServerMcplCaps = {};

    // §10: Context hooks
    const contextHooks = mcpl.contextHooks;
    if (contextHooks) {
      const hooks: McpHookCapabilities = {};
      if (contextHooks.beforeInference) hooks.beforeInference = true;
      if (contextHooks.afterInference) {
        hooks.afterInference = typeof contextHooks.afterInference === 'object'
          ? { blocking: contextHooks.afterInference.blocking === true }
          : true;
      }
      if (hooks.beforeInference || hooks.afterInference) result.hooks = hooks;
    }

    // §9: Push events
    if (mcpl.pushEvents) result.pushEvents = true;
    // §11: Inference requests
    if (mcpl.inferenceRequest) result.inferenceRequest = true;
    // §7.1: Scoped access
    if (mcpl.scoped) result.scoped = true;
    // §8.1: Rollback support
    if (mcpl.rollback) result.rollback = true;
    // §14: Channels
    if (mcpl.channels) {
      result.channels = {};
      if (mcpl.channels.publish) result.channels.publish = true;
      if (mcpl.channels.observe) result.channels.observe = true;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  private async collectTools(server: McpServer): Promise<void> {
    // DEL-13: Handle cursor-based pagination for large tool sets
    const allTools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = await withTimeout(
        server.client.listTools(cursor ? { cursor } : undefined),
        15_000,
        `listTools(${server.name})`
      );
      for (const tool of result.tools) {
        // D-10: Validate inputSchema — properties must be an object, required must be string[]
        const rawSchema = tool.inputSchema as any;
        const properties = rawSchema?.properties;
        const required = rawSchema?.required;
        allTools.push({
          name: tool.name,
          description: tool.description || '',
          inputSchema: {
            type: 'object' as const,
            properties: (properties && typeof properties === 'object' && !Array.isArray(properties))
              ? properties
              : {},
            required: (Array.isArray(required) && required.every((r: unknown) => typeof r === 'string'))
              ? required
              : undefined,
          },
        });
      }
      cursor = result.nextCursor;
    } while (cursor);
    server.tools = allTools;
  }
}
