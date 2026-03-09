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

interface McpServer {
  name: string;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: ToolDefinition[];
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
  description: 'Request capability elevation from the user. Returns { approved: boolean, newCapabilities?: string[] }.',
  inputSchema: {
    type: 'object',
    properties: {
      featureSet: { type: 'string', description: 'Feature set label to elevate' },
      label: { type: 'string', description: 'Human-readable label for the request' },
      reason: { type: 'string', description: 'Why elevation is needed' },
      capabilities: { type: 'array', items: { type: 'string' }, description: 'Capabilities to request' },
    },
    required: ['featureSet', 'label', 'reason', 'capabilities'],
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

// =============================================================================
// McpHostManager
// =============================================================================

export class McpHostManager {
  private servers: Map<string, McpServer> = new Map();
  private toolToServer: Map<string, string> = new Map();
  private _duplicateWarnings: DuplicateToolWarning[] = [];
  private scopeElevateHandler?: (input: Record<string, unknown>) => Promise<{ approved: boolean; newCapabilities?: string[] }>;

  /** MCP server configs from delegate.yaml (set by setMcpConfigs, used for enable/restart) */
  private mcpConfigs: McpServerConfig[] = [];

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
  setScopeElevateHandler(handler: (input: Record<string, unknown>) => Promise<{ approved: boolean; newCapabilities?: string[] }>): void {
    this.scopeElevateHandler = handler;
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
        tools.push({ ...tool, serverName });
      }
    }
    // Append virtual tools (no serverName — delegate-internal)
    if (this.scopeElevateHandler) {
      tools.push(SCOPE_ELEVATE_TOOL);
    }
    // MCP management tools always available
    tools.push(...MCP_MANAGEMENT_TOOLS);
    return tools;
  }

  /**
   * Get duplicate warnings from the last tool collection.
   */
  getDuplicateWarnings(): DuplicateToolWarning[] {
    return this._duplicateWarnings;
  }

  /**
   * Call a tool by name, routing to the correct MCP server.
   * Intercepts virtual _scope_elevate tool before MCP server routing.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    // Intercept virtual _scope_elevate tool
    if (name === '_scope_elevate' && this.scopeElevateHandler) {
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
        server.client.callTool({ name, arguments: args }),
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

    const client = new Client(
      { name: `animachat-delegate:${name}`, version: '1.0.0' },
      { capabilities: {} }
    );

    const transport = new SSEClientTransport(parsedUrl);
    await withTimeout(client.connect(transport), 30_000, `connect(SSE:${name})`);

    // DEL-14: Detect SSE server connection loss (must be after connect())
    client.onclose = () => {
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

    const server: McpServer = { name, client, transport, tools: [] };
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
      // BUG-12 fix: process.env values may be undefined. Filter them out instead of
      // using unsafe `as Record<string, string>` cast which masks the type mismatch.
      env: config.env
        ? Object.fromEntries(
            Object.entries({ ...process.env, ...config.env }).filter((entry): entry is [string, string] => entry[1] !== undefined)
          )
        : undefined,
    });

    const client = new Client(
      { name: `animachat-delegate:${config.name}`, version: '1.0.0' },
      { capabilities: {} }
    );

    await withTimeout(client.connect(transport), 30_000, `connect(stdio:${config.name})`);

    // DEL-12: Detect MCP server crash/exit (must be set AFTER connect() which replaces callbacks)
    const serverName = config.name;
    client.onclose = () => {
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

    const server: McpServer = {
      name: config.name,
      client,
      transport,
      tools: [],
    };

    // Collect tools from this server
    await this.collectTools(server);

    this.servers.set(config.name, server);
    console.log(`[McpHost] "${config.name}" started with ${server.tools.length} tools`);
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
