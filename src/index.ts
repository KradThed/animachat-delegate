#!/usr/bin/env node
/**
 * Animachat Delegate CLI
 *
 * Standalone app that connects to an Animachat server, hosts MCP servers
 * locally for remote tool execution, and optionally serves webhook endpoints
 * for external event triggers (MCP Live).
 *
 * Usage:
 *   animachat-delegate --config delegate.yaml
 *   animachat-delegate --server wss://animachat.example.com --token $TOKEN
 */

import { randomUUID } from 'crypto';
import { Command } from 'commander';
import { findConfigPath, loadConfig } from './config.js';
import { DelegateConnection } from './connection.js';
import { McpHostManager } from './mcp-host.js';
import { WebhookServer } from './webhook-server.js';
import type { ToolCallRequest } from './types.js';

// =============================================================================
// CLI
// =============================================================================

const program = new Command()
  .name('animachat-delegate')
  .description('Animachat delegate - remote tool execution and MCP hosting')
  .version('1.0.0')
  .option('-c, --config <path>', 'Path to config YAML file')
  .option('-s, --server <url>', 'Server WebSocket URL (overrides config)')
  .option('-t, --token <token>', 'Auth token (overrides config)')
  .option('-d, --delegate-id <id>', 'Delegate ID (overrides config)')
  .option('-q, --quiet', 'Suppress periodic status logs')
  .option('--list-tools', 'Start MCP servers, list tools, exit (note: servers briefly started)')
  .option('--dry-run', 'Same as --list-tools')
  .option('--config-only', 'Validate config without starting servers');

// ---- Subcommand: login ----
program
  .command('login')
  .description('Get a delegate API key (opens browser)')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:3010')
  .action(async (loginOpts) => {
    const webUrl = loginOpts.server.replace(/^ws/, 'http');
    console.log(`Opening: ${webUrl} → Settings > Delegates`);

    const { exec } = await import('child_process');
    const cmd = process.platform === 'win32' ? 'start' :
                process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} "${webUrl}"`);

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nPaste API key (dak_...): ', (key) => {
      rl.close();
      if (!key.trim().startsWith('dak_')) {
        console.error('Invalid format. Expected dak_...');
        process.exit(1);
      }
      console.log('\nAdd to delegate.yaml:\n');
      console.log(`server:\n  url: "${loginOpts.server}"\n  token: "${key.trim()}"\n`);
      process.exit(0);
    });
  });

// ---- Subcommand: init ----
program
  .command('init')
  .description('Create delegate.yaml interactively')
  .action(async () => {
    const { existsSync, writeFileSync } = await import('fs');
    const { hostname } = await import('os');

    if (existsSync('delegate.yaml')) {
      console.error('delegate.yaml already exists. Delete it or use another directory.');
      process.exit(1);
    }

    const { createInterface } = await import('readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string, def?: string): Promise<string> =>
      new Promise(r => rl.question(`${q}${def ? ` [${def}]` : ''}: `, a => r(a.trim() || def || '')));

    console.log('Animachat Delegate Setup\n');
    const url = await ask('Server URL', 'ws://localhost:3010');
    const token = await ask('API key (dak_...)');
    const id = await ask('Delegate name', hostname());
    rl.close();

    if (token && !token.startsWith('dak_')) {
      console.warn('Warning: key doesn\'t start with dak_');
    }

    const yaml = [
      `server:`,
      `  url: "${url}"`,
      `  token: "${token}"`,
      ``,
      `delegate:`,
      `  id: "${id}"`,
      `  capabilities:`,
      `    - mcp_host`,
      ``,
      `mcp_servers: []`,
      `  # - name: filesystem`,
      `  #   command: npx`,
      `  #   args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"]`,
      ``,
    ].join('\n');
    writeFileSync('delegate.yaml', yaml, 'utf-8');
    console.log('\n✓ Created delegate.yaml');
    console.log('Edit to add MCP servers, then run: animachat-delegate');
  });

// Default action: run main delegate flow when no subcommand is given.
// Without this, Commander shows help when subcommands are registered.
let runMain = false;
program.action(() => { runMain = true; });

program.parse();

const opts = program.opts();

// =============================================================================
// Module-scope state
// =============================================================================

let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  // Load config
  const configPath = findConfigPath(opts.config);
  console.log(`[Delegate] Loading config from ${configPath}`);
  const config = loadConfig(configPath);

  // CLI overrides
  if (opts.server) config.server.url = opts.server;
  if (opts.token) config.server.token = opts.token;
  if (opts.delegateId) config.delegate.id = opts.delegateId;

  // --config-only: validate and exit without starting servers
  if (opts.configOnly) {
    console.log('Config valid!');
    console.log(`  ID: ${config.delegate.id}`);
    console.log(`  Server: ${config.server.url}`);
    console.log(`  MCP servers: ${config.mcp_servers.length}`);
    config.mcp_servers.forEach((s: any) =>
      console.log(`    - ${s.name}: ${s.command} ${(s.args || []).join(' ')}`)
    );
    process.exit(0);
  }

  console.log(`[Delegate] ID: ${config.delegate.id}`);
  console.log(`[Delegate] Server: ${config.server.url}`);
  console.log(`[Delegate] MCP servers: ${config.mcp_servers.length}`);
  console.log(`[Delegate] Webhooks: ${config.webhooks.enabled ? `enabled (port ${config.webhooks.port})` : 'disabled'}`);

  // ---- MCP Host Manager ----
  const mcpHost = new McpHostManager();
  await mcpHost.startAll(config.mcp_servers);
  const tools = mcpHost.getAllToolsWithServer();
  console.log(`[Delegate] Tools available: ${tools.map(t => `${t.name} (${t.serverName})`).join(', ') || '(none)'}`);

  // --list-tools / --dry-run: list discovered tools and exit
  if (opts.listTools || opts.dryRun) {
    console.log(`\n${tools.length} tools discovered:`);
    for (const t of tools) {
      console.log(`  ${config.delegate.id}__${t.name}  (${t.serverName || 'virtual'})`);
      if (t.description) console.log(`    ${t.description.slice(0, 80)}`);
    }
    const warnings = mcpHost.getDuplicateWarnings();
    if (warnings.length) {
      console.log(`\n${warnings.length} duplicate warnings:`);
      warnings.forEach((w) => console.log(`  ⚠ ${w.toolName}: ${w.fromServer} conflicts with ${w.conflictsWith}`));
    }
    await mcpHost.stopAll();
    process.exit(0);
  }

  // ---- WebSocket Connection ----
  const connection = new DelegateConnection({
    serverUrl: config.server.url,
    token: config.server.token,
    delegateId: config.delegate.id,
    capabilities: config.delegate.capabilities,
  });

  // Send tool manifest on connect (and reconnect)
  connection.on('connected', (_sessionId: string, _userId: string) => {
    const currentTools = mcpHost.getAllToolsWithServer();
    if (currentTools.length > 0) {
      const warnings = mcpHost.getDuplicateWarnings();
      connection.sendToolManifest(currentTools, warnings.length > 0 ? warnings : undefined);
    } else {
      console.log('[Delegate] No tools to advertise');
    }
  });

  // Handle tool call requests from the server
  connection.on('tool_call_request', async (request: ToolCallRequest) => {
    console.log(`[Delegate] Tool call: ${request.tool.name} (request: ${request.requestId})`);

    const result = await mcpHost.callTool(request.tool.name, request.tool.input);

    connection.sendToolCallResponse(
      request.requestId,
      request.tool.id,
      result.content,
      result.isError
    );

    console.log(
      `[Delegate] Tool result sent: ${request.tool.name} ` +
      `(${result.isError ? 'error' : 'ok'}, ${result.content.length} chars)`
    );
  });

  connection.on('error', (error: Error) => {
    console.error('[Delegate] Connection error:', error.message);
  });

  connection.on('reconnecting', (attempt: number) => {
    console.log(`[Delegate] Reconnecting (attempt ${attempt})...`);
  });

  connection.on('disconnected', (_code: number, reason: string) => {
    console.log(`[Delegate] Disconnected: ${reason}`);
  });

  // Phase 7 Gap 6: Wire _scope_elevate virtual tool to connection
  mcpHost.setScopeElevateHandler(async (input) => {
    return new Promise((resolve) => {
      const requestId = randomUUID();

      // Send scope elevate request to backend
      connection.sendScopeElevateRequest({
        requestId,
        delegateId: config.delegate.id,
        serverId: '',  // virtual tool, no specific server
        conversationId: '',  // backend resolves from mcplSessionManager
        featureSet: String(input.featureSet || ''),
        label: String(input.label || ''),
        requestedCapabilities: (input.capabilities as string[]) || [],
        reason: String(input.reason || ''),
      });

      // Listen for result (mcpl/scope_elevate_result → mcpl_scope_elevate_result)
      const handler = (msg: any) => {
        if (msg.requestId === requestId) {
          connection.removeListener('mcpl_scope_elevate_result', handler);
          resolve({ approved: msg.approved, newCapabilities: msg.newCapabilities });
        }
      };
      connection.on('mcpl_scope_elevate_result', handler);

      // Timeout after 65s (slightly longer than backend's 60s)
      setTimeout(() => {
        connection.removeListener('mcpl_scope_elevate_result', handler);
        resolve({ approved: false });
      }, 65_000);
    });
  });

  // Connect to server
  await connection.connect();

  // ---- Heartbeat Status Log ----
  if (!opts.quiet) {
    const connectedAt = Date.now();
    const EARLY = 60_000;       // 1min
    const LATE = 300_000;       // 5min
    const EARLY_WINDOW = 300_000; // first 5min

    const logStatus = () => {
      const currentTools = mcpHost.getAllToolsWithServer();
      const uptime = Math.floor((Date.now() - connectedAt) / 60_000);
      console.log(`[Delegate] ✓ ${currentTools.length} tools | uptime ${uptime}m`);
    };

    const schedule = () => {
      const interval = (Date.now() - connectedAt) < EARLY_WINDOW ? EARLY : LATE;
      heartbeatTimer = setTimeout(() => { logStatus(); schedule(); }, interval);
    };
    schedule();
  }

  // ---- Webhook Server ----
  let webhookServer: WebhookServer | null = null;
  if (config.webhooks.enabled && config.webhooks.endpoints.length > 0) {
    webhookServer = new WebhookServer(connection);
    webhookServer.start(config.webhooks.port, config.webhooks.endpoints);
  }

  // ---- Graceful Shutdown ----
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    if (heartbeatTimer) clearTimeout(heartbeatTimer);

    console.log(`\n[Delegate] ${signal} received, shutting down...`);

    webhookServer?.stop();
    connection.disconnect();
    await mcpHost.stopAll();

    console.log('[Delegate] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[Delegate] Running. Press Ctrl+C to stop.');
}

// =============================================================================
// Entry
// =============================================================================

// Only run main() when no subcommand (login, init) was invoked.
// Subcommands have their own action handlers that call process.exit().
if (runMain) {
  main().catch((error) => {
    console.error('[Delegate] Fatal error:', error);
    process.exit(1);
  });
}
