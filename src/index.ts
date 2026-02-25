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
import { withLock } from './config-utils.js'; // DEL-11
import type { ToolCallRequest } from './types.js';

// =============================================================================
// BUG 9: _mcpl chain context injection for MCPL-aware MCP servers
// =============================================================================

/**
 * Conditionally inject `_mcpl` chain tracking context into tool input.
 *
 * - `_mcpl` is a reserved field — spread puts it last, overwriting any
 *   pre-existing value (prevents MCP servers from spoofing chain context).
 * - Returns the same reference if no injection needed (zero allocation).
 *
 * @param toolInput - Original tool input from the server
 * @param inferenceContext - Chain/frame IDs (undefined if not in an inference chain)
 * @param acceptsMcplContext - Whether the target MCP server opted in via config
 */
export function maybeInjectMcpl(
  toolInput: Record<string, unknown>,
  inferenceContext: { chainId: string; frameId: string } | undefined,
  acceptsMcplContext: boolean,
): Record<string, unknown> {
  if (!inferenceContext || !acceptsMcplContext) return toolInput;
  return {
    ...toolInput,
    _mcpl: {
      v: 1,
      chainId: inferenceContext.chainId,
      frameId: inferenceContext.frameId,
    },
  };
}

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
  .option('--config-only', 'Validate config without starting servers')
  .option('--no-tui', 'Disable TUI dashboard (plain log output)');

// Flag set by `init` (option 1: "Start delegate now") or default action
let runMain = false;

// =============================================================================
// Login Flow (reusable by both `login` and `init` subcommands)
// =============================================================================

interface LoginFlowOptions {
  config: string;            // resolved config path
  frontend?: string;         // --frontend override
  browser?: boolean;         // false = --no-browser
  parentServerUrl?: string;  // from program.opts().server or init's prompt
  skipExistingKeyCheck?: boolean;  // init handles this itself
}

interface LoginFlowResult {
  success: boolean;
  namespace?: string;
  configPath?: string;
  error?: string;
  cancelled?: boolean;
}

async function loginFlow(opts: LoginFlowOptions): Promise<LoginFlowResult> {
  const crypto = await import('crypto');
  const http = await import('http');
  const { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } = await import('fs');
  const { resolve } = await import('path');
  const YAML = await import('yaml');
  const { promptText, promptConfirm } = await import('./prompts.js');

  const configPath = resolve(opts.config);
  const fsDeps = { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, YAML, resolve };

  // L5: validation regexes
  const API_KEY_RE = /^dak_[A-Za-z0-9]{8,}$/;
  const NAMESPACE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  // Non-interactive check
  if (!process.stdin.isTTY) {
    return { success: false, error: 'Non-interactive mode. Use --no-browser and provide key via env.' };
  }

  // Resolve server URL: explicit → existing delegate.yaml → default
  let serverUrl: string = opts.parentServerUrl || '';
  if (!serverUrl && existsSync(configPath)) {
    try {
      const existing = YAML.parse(readFileSync(configPath, 'utf-8'));
      serverUrl = existing?.server?.url || '';
    } catch {}
  }
  if (!serverUrl) serverUrl = 'ws://localhost:3010';

  // Normalize to http for API calls (ws:// is canonical in config)
  const serverHttpUrl = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  const wsUrl = serverUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

  // Frontend URL: --frontend flag → same as server HTTP base (production default)
  const frontendUrl = opts.frontend || serverHttpUrl;

  // Check if config exists with a key already
  if (!opts.skipExistingKeyCheck && existsSync(configPath)) {
    try {
      const existing = YAML.parse(readFileSync(configPath, 'utf-8'));
      if (existing?.server?.token) {
        const answer = await promptConfirm('Config already has an API key. Replace?');
        if (answer === null) return { success: false, cancelled: true };
        if (!answer) return { success: false, cancelled: true };
      }
    } catch {}
  }

  // PKCE generation
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');

  // Local HTTP server for callback
  const server = http.createServer();

  // ── Idempotent helpers (L1-L4) ──

  // A) Safe, idempotent server close
  let serverClosed = false;
  function closeServer() {
    if (serverClosed) return;
    serverClosed = true;
    try { server.close(); } catch {}
  }

  // B) Safe response end — don't write to closed/ended response (L2)
  function safeEnd(res: any, status = 200, body = 'OK') {
    try { if (!res.headersSent) res.writeHead(status); } catch {}
    try { if (!res.writableEnded) res.end(body); } catch {}
  }

  // C) Single-resolve state
  let resolved = false;
  let resolveLogin!: (result: LoginFlowResult) => void;
  const loginPromise = new Promise<LoginFlowResult>(r => { resolveLogin = r; });
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();

  function finalize(result: LoginFlowResult): void {
    if (resolved) return;          // L4: single-resolve
    resolved = true;
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
    abortController.abort();        // cancel in-flight fetch
    closeServer();                  // L1, L3: always close server
    resolveLogin(result);
  }

  // L7: handle listen errors
  server.on('error', (err: Error) => {
    finalize({ success: false, error: `Server listen failed: ${err.message}` });
  });

  try {
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    // Build authorize URL and open browser (uses frontend URL for SPA)
    const authorizeUrl = `${frontendUrl}/authorize-delegate?` + new URLSearchParams({
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    }).toString();

    const openBrowser = opts.browser !== false;
    if (openBrowser) {
      console.log('Opening browser for authorization...');
      const { exec } = await import('child_process');
      if (process.platform === 'win32') {
        exec(`start "" "${authorizeUrl}"`);
      } else if (process.platform === 'darwin') {
        exec(`open "${authorizeUrl}"`);
      } else {
        exec(`xdg-open "${authorizeUrl}"`);
      }
    } else {
      console.log('Open this URL in your browser:');
      console.log(`  ${authorizeUrl}\n`);
    }

    console.log('Waiting for authorization...');

    // Timeout — L2: race resolved by finalize() guard
    timeoutHandle = setTimeout(() => {
      finalize({ success: false, error: 'timeout' });
    }, 120_000);

    // Request handler
    server.on('request', (req: any, res: any) => {
      // L2: late callback after finalize — just end the response
      if (resolved) { safeEnd(res); return; }

      const url = new URL(req.url!, `http://127.0.0.1:${port}`);

      // Not our callback path
      if (url.pathname !== '/callback') {
        safeEnd(res, 404, 'Not found');
        return;
      }

      const callbackState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      // Bad state — potential attacker, reject
      if (callbackState !== state) {
        safeEnd(res, 400, '<html><body><h2>Invalid request</h2></body></html>');
        return;
      }

      try {
        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authorization cancelled</h2><p>You can close this tab.</p></body></html>');
          finalize(error === 'access_denied'
            ? { success: false, cancelled: true }
            : { success: false, error: `Authorization error: ${error}` });
          return;
        }

        // Success — show redirect page
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=${frontendUrl}"></head><body><h2>✓ Authorized</h2><p>Redirecting to AnimaChat...</p></body></html>`);

        // Exchange code for API key (async, don't block response)
        exchangeCode(code!);
      } finally {
        safeEnd(res);  // B) always end response — don't leave browser socket hanging
      }
    });

    // Exchange authorization code for API key
    async function exchangeCode(code: string): Promise<void> {
      try {
        // L6: use new URL() to avoid double-slash
        const exchangeUrl = new URL('/api/delegates/exchange', serverHttpUrl);
        const response = await fetch(exchangeUrl.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, code_verifier: codeVerifier }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          // L8: better error message
          const body = await response.json().catch(() => null) as Record<string, unknown> | null;
          const errMsg = body?.error
            ? String(body.error)
            : `HTTP ${response.status} ${response.statusText}`;
          finalize({ success: false, error: errMsg });
          return;
        }

        const result = await response.json() as { api_key: string; namespace: string };

        // L5: validate both api_key and namespace before writing config
        if (!API_KEY_RE.test(result.api_key)) {
          finalize({ success: false, error: 'Server returned invalid API key format' });
          return;
        }
        if (!NAMESPACE_RE.test(result.namespace)) {
          finalize({ success: false, error: `Server returned invalid namespace: ${result.namespace}` });
          return;
        }

        writeConfigYaml(configPath, wsUrl, result.api_key, result.namespace, fsDeps);
        finalize({ success: true, namespace: result.namespace, configPath });
      } catch (err: any) {
        if (err.name === 'AbortError') return;  // already finalized
        finalize({ success: false, error: err.message });
      }
    }

    // Wait for finalize() to be called from any path
    const result = await loginPromise;

    // Handle timeout fallback — manual key paste
    if (!result.success && result.error === 'timeout') {
      console.log('\nBrowser authorization timed out.');
      const key = await promptText('Paste API key (dak_...)');
      if (key === null) return { success: false, cancelled: true };
      // L5: validate manual key too
      if (!API_KEY_RE.test(key)) {
        return { success: false, error: 'Invalid format. Expected dak_...' };
      }
      writeConfigYaml(configPath, wsUrl, key, 'manual', fsDeps);
      return { success: true, namespace: 'manual', configPath };
    }

    return result;
  } finally {
    // Safety net: always close server even on unexpected throw
    closeServer();
  }
}

// ---- Subcommand: login (PKCE OAuth flow) ----
program
  .command('login')
  .description('Authorize delegate via browser (PKCE)')
  .option('--frontend <url>', 'Frontend URL (dev only, when frontend port differs from backend)')
  .option('--no-browser', 'Print URL instead of opening browser')
  .option('-c, --config <path>', 'Config file path', 'delegate.yaml')
  .action(async (loginOpts) => {
    const { resolve } = await import('path');
    const result = await loginFlow({
      config: resolve(loginOpts.config),
      frontend: loginOpts.frontend,
      browser: loginOpts.browser,
      parentServerUrl: program.opts().server,
    });

    if (!result.success) {
      if (result.cancelled) {
        console.log('Cancelled.');
      } else {
        console.error('Login failed:', result.error);
      }
      process.exitCode = result.cancelled ? 0 : 1;
      return;
    }

    console.log('\nLogin successful!');
    console.log(`  Namespace: ${result.namespace}`);
    console.log(`  Config: ${result.configPath}`);
    console.log('\nNext: edit delegate.yaml to add MCP servers, then run: animachat-delegate');
  });

/**
 * Write or update delegate.yaml atomically.
 * If file exists, preserves mcp_servers and webhooks sections.
 */
function writeConfigYaml(
  configPath: string,
  serverUrl: string,
  apiKey: string,
  namespace: string,
  deps: { existsSync: any; readFileSync: any; writeFileSync: any; renameSync: any; chmodSync: any; YAML: any; resolve: any },
) {
  // DEL-11: Use lock to prevent TOCTOU with concurrent config writers
  withLock(configPath, () => {
    let config: any;

    if (deps.existsSync(configPath)) {
      // Preserve existing config, update auth fields
      const raw = deps.readFileSync(configPath, 'utf-8');
      config = deps.YAML.parse(raw) || {};
      if (!config.server) config.server = {};
      config.server.url = serverUrl;
      config.server.token = apiKey;
      if (!config.delegate) config.delegate = {};
      config.delegate.id = namespace;
      if (!config.delegate.capabilities) config.delegate.capabilities = ['mcp_host'];
    } else {
      // Create new config
      config = {
        server: { url: serverUrl, token: apiKey },
        delegate: { id: namespace, capabilities: ['mcp_host'] },
        mcp_servers: [],
        webhooks: { enabled: false, port: 8080, endpoints: [] },
      };
    }

    const yaml = deps.YAML.stringify(config);
    const tmpPath = configPath + '.tmp';
    deps.writeFileSync(tmpPath, yaml, 'utf-8');

    // chmod 600 on Unix (best effort on Windows)
    if (process.platform !== 'win32') {
      try { deps.chmodSync(tmpPath, 0o600); } catch {}
    }

    deps.renameSync(tmpPath, configPath);
  });
}

// ---- Subcommand: init (full onboarding) ----
program
  .command('init')
  .description('Set up delegate: login + configure MCP servers')
  .option('--frontend <url>', 'Frontend URL (dev only)')
  .option('--no-browser', 'Print URL instead of opening browser')
  .option('-c, --config <path>', 'Config file path', 'delegate.yaml')
  .action(async (initOpts) => {
    const { existsSync, readFileSync } = await import('fs');
    const { resolve } = await import('path');
    const YAML = await import('yaml');
    const { promptText, promptSelect, promptConfirm } = await import('./prompts.js');
    const { interactiveMcpAdd } = await import('./mcp-commands.js');

    const configPath = resolve(initOpts.config);

    console.log('Animachat Delegate Setup\n');

    // --- Handle existing config ---
    if (existsSync(configPath)) {
      let existingConfig: any = {};
      try {
        existingConfig = YAML.parse(readFileSync(configPath, 'utf-8')) || {};
      } catch {}

      const mcpCount = existingConfig?.mcp_servers?.length || 0;
      console.log(`Found existing config: ${configPath}`);
      if (existingConfig?.server?.url) console.log(`  Server: ${existingConfig.server.url}`);
      if (existingConfig?.delegate?.id) console.log(`  Namespace: ${existingConfig.delegate.id}`);
      console.log(`  MCP servers: ${mcpCount}`);

      const choice = await promptSelect('What would you like to do?', [
        'Start delegate now',
        'Login again (rotate key / change namespace)',
        'Add MCP servers',
        'Recreate config from scratch',
        'Cancel',
      ]);

      if (choice === null || choice === 4) {
        process.exitCode = 0;
        return;
      }

      if (choice === 0) {
        // Start delegate — set runMain and let it fall through
        console.log('\nStarting delegate...\n');
        runMain = true;
        return;
      }

      if (choice === 1) {
        // Login again
        const result = await loginFlow({
          config: configPath,
          frontend: initOpts.frontend,
          browser: initOpts.browser,
          parentServerUrl: existingConfig?.server?.url,
          skipExistingKeyCheck: true,
        });
        if (result.success) {
          console.log(`\nLogin successful! Namespace: ${result.namespace}`);
        } else if (!result.cancelled) {
          console.error('Login failed:', result.error);
          process.exitCode = 1;
        }
        return;
      }

      if (choice === 2) {
        // Add MCP servers in a loop
        let adding = true;
        while (adding) {
          const added = await interactiveMcpAdd(configPath);
          if (!added) break;
          const more = await promptConfirm('Add another MCP server?');
          if (more === null || !more) adding = false;
        }
        return;
      }

      // choice === 3: Recreate — fall through to fresh config flow
    }

    // --- Fresh config flow ---
    const serverUrl = await promptText('Server URL', 'ws://localhost:3010');
    if (serverUrl === null) return;

    // Login via PKCE
    console.log('\nStarting browser login...');
    const result = await loginFlow({
      config: configPath,
      frontend: initOpts.frontend,
      browser: initOpts.browser,
      parentServerUrl: serverUrl,
      skipExistingKeyCheck: true,
    });

    if (!result.success) {
      if (result.cancelled) {
        console.log('Login cancelled.');
      } else {
        console.error('Login failed:', result.error);
        process.exitCode = 1;
      }
      return;
    }

    console.log(`\nLogged in! Namespace: ${result.namespace}`);

    // Offer to add MCP servers
    const addServers = await promptConfirm('Would you like to add an MCP server now?');
    if (addServers) {
      let adding = true;
      while (adding) {
        const added = await interactiveMcpAdd(configPath);
        if (!added) break;
        const more = await promptConfirm('Add another MCP server?');
        if (more === null || !more) adding = false;
      }
    }

    // Offer to start
    const startNow = await promptConfirm('Start the delegate now?');
    if (startNow) {
      console.log('\nStarting delegate...\n');
      runMain = true;
      return;
    }

    console.log('\nSetup complete!');
    console.log(`  Config: ${configPath}`);
    console.log('  Run: animachat-delegate');
  });

// ---- Subcommand group: mcp ----
const mcpCmd = program
  .command('mcp')
  .description('Manage MCP server configuration');

mcpCmd
  .command('add')
  .description('Add an MCP server to delegate.yaml')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts) => {
    const { interactiveMcpAdd } = await import('./mcp-commands.js');
    await interactiveMcpAdd(opts.config);
  });

mcpCmd
  .command('list')
  .description('List configured MCP servers')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts) => {
    const { listMcpServers } = await import('./mcp-commands.js');
    try {
      listMcpServers(opts.config);
    } catch (err: any) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

mcpCmd
  .command('remove <name>')
  .description('Remove an MCP server by name')
  .option('-c, --config <path>', 'Config file path')
  .option('--yes', 'Skip confirmation')
  .action(async (name: string, opts) => {
    const { removeMcpServer } = await import('./mcp-commands.js');
    try {
      const removed = await removeMcpServer(name, opts.config, opts.yes);
      if (!removed) process.exitCode = 1;
    } catch (err: any) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

// ---- Subcommand group: config ----
const configCmd = program
  .command('config')
  .description('View delegate configuration');

configCmd
  .command('path')
  .description('Print the resolved config file path')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts) => {
    const { readConfigRaw } = await import('./config-utils.js');
    try {
      const { path: cfgPath } = readConfigRaw(opts.config);
      console.log(cfgPath);
    } catch (err: any) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

configCmd
  .command('show')
  .description('Show sanitized config (API key hidden)')
  .option('-c, --config <path>', 'Config file path')
  .action(async (opts) => {
    const { readConfigRaw, maskApiKey, deriveHttpUrl } = await import('./config-utils.js');
    try {
      const { path: cfgPath, data: config } = readConfigRaw(opts.config);

      console.log(`Config: ${cfgPath}\n`);

      // Server
      const serverUrl = config.server?.url || '(not set)';
      const httpUrl = deriveHttpUrl(serverUrl);
      console.log(`Server: ${serverUrl}`);
      console.log(`  API: ${httpUrl}/api    (derived)`);
      console.log(`  WS:  ${serverUrl}`);

      // Auth
      console.log(`API key: ${maskApiKey(config.server?.token)}`);

      // Delegate
      console.log(`Namespace: ${config.delegate?.id || '(not set)'}`);
      console.log(`Capabilities: ${(config.delegate?.capabilities || []).join(', ') || '(none)'}`);

      // MCP servers
      const servers = config.mcp_servers || [];
      console.log(`\nMCP servers (${servers.length}):`);
      if (servers.length === 0) {
        console.log('  (none)');
      } else {
        servers.forEach((s: any, i: number) => {
          const envKeys = s.env ? Object.keys(s.env) : [];
          console.log(`  ${i + 1}. ${s.name}: ${s.command} ${(s.args || []).join(' ')}`);
          if (envKeys.length > 0) {
            console.log(`     env: ${envKeys.join(', ')}`);
          }
        });
      }

      // Webhooks
      const wh = config.webhooks;
      if (wh?.enabled) {
        console.log(`\nWebhooks: enabled (port ${wh.port})`);
        (wh.endpoints || []).forEach((ep: any) => {
          console.log(`  ${ep.source}: ${ep.path}`);
        });
      } else {
        console.log('\nWebhooks: disabled');
      }
    } catch (err: any) {
      console.error(err.message);
      process.exitCode = 1;
    }
  });

// Default action: run main delegate flow when no subcommand is given.
// Without this, Commander shows help when subcommands are registered.
program.action(() => { runMain = true; });

program.parse();

const opts = program.opts();

// =============================================================================
// Module-scope state
// =============================================================================

// heartbeatTimer removed — replaced by TelemetryBus tick system

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const { TelemetryBus } = await import('./telemetry.js');
  const { DEFAULTS } = await import('./constants.js');

  // Load config
  const configPath = findConfigPath(opts.config);
  let config = loadConfig(configPath);

  // Fix #3: Ensure all MCP servers have persistent IDs (auto-generate if missing)
  const { ensureServerIds } = await import('./config-utils.js');
  ensureServerIds(opts.config, config.delegate.id);

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

  // ---- MCP Host Manager ----
  const mcpHost = new McpHostManager();
  mcpHost.setMcpConfigs(config.mcp_servers);
  await mcpHost.startAll(config.mcp_servers);
  const tools = mcpHost.getAllToolsWithServer();

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
      warnings.forEach((w) => console.log(`  \u26A0 ${w.toolName}: ${w.fromServer} conflicts with ${w.conflictsWith}`));
    }
    await mcpHost.stopAll();
    process.exit(0);
  }

  // ---- TelemetryBus ----
  const bus = new TelemetryBus();

  // DEL-12: Wire MCP server crash detection to telemetry
  mcpHost.onServerDied = (name) => {
    bus.pushError(`MCP server "${name}" crashed`, name);
    handleToolsetChange('server_crashed', name);
  };

  // Feature 3: Notify server when toolset changes (enable/disable/restart/crash)
  mcpHost.onToolsetChanged = (reason, serverName) => {
    handleToolsetChange(reason, serverName);
  };

  function handleToolsetChange(reason: string, serverName: string): void {
    const newTools = mcpHost.getAllToolsWithServer();
    bus.setTools(newTools.map(t => ({ name: t.name, server: (t as any).serverName || '' })));

    // Re-send tool manifest so server knows about new toolset (Feature 4: with reason for history)
    if (connection.isConnected) {
      const warnings = mcpHost.getDuplicateWarnings();
      connection.sendToolManifest(newTools, warnings.length > 0 ? warnings : undefined, `${reason}:${serverName}`);

      // Feature 3+4: Send push event with toolset change context
      if (connection.isMcpl) {
        connection.sendPushEvent({
          id: randomUUID(),
          source: 'delegate',
          conversationId: '',  // broadcast — not conversation-specific
          eventType: 'toolset_changed',
          payload: {
            reason,
            serverName,
            tools: newTools.map(t => ({
              name: t.name,
              server: (t as any).serverName || 'virtual',
            })),
          },
          systemMessage: `Delegate toolset changed (${reason}: ${serverName}). ${newTools.length} tools now available.`,
          idempotencyKey: `toolset-${reason}-${serverName}-${Date.now()}`,
        });
      }
    }
  }

  bus.setSetupStep('config', 'ok', configPath);
  bus.setSetupStep('mcp_servers', tools.length > 0 ? 'ok' : 'error',
    tools.length > 0 ? `${tools.length} tools` : 'No tools');
  bus.setTools(tools.map(t => ({ name: t.name, server: (t as any).serverName || '' })));

  // Start process tick (heartbeat, always 60s initially)
  bus.startProcessTick();

  // ---- WebSocket Connection ----
  const connection = new DelegateConnection({
    serverUrl: config.server.url,
    token: config.server.token,
    delegateId: config.delegate.id,
    capabilities: config.delegate.capabilities,
  });

  // Send tool manifest on connect (and reconnect)
  connection.on('connected', (_sessionId: string, _userId: string) => {
    bus.setConnectionState('connected');
    bus.setSetupStep('websocket', 'ok', 'Connected');

    const currentTools = mcpHost.getAllToolsWithServer();
    if (currentTools.length > 0) {
      const warnings = mcpHost.getDuplicateWarnings();
      connection.sendToolManifest(currentTools, warnings.length > 0 ? warnings : undefined, 'initial');
      bus.setSetupStep('manifest', 'ok', `${currentTools.length} tools`);
    } else {
      bus.setSetupStep('manifest', 'error', 'No tools to advertise');
    }

    // Schedule tick slowdown after 5min stable connected
    bus.scheduleSlowTick();
  });

  // Handle tool call requests from the server
  connection.on('tool_call_request', async (request: ToolCallRequest) => {
    // Reject during reload
    if (bus.isReloading) {
      connection.sendToolCallResponse(
        request.requestId,
        request.tool.id,
        'MCP servers are reloading, please retry in a moment.',
        true,
      );
      return;
    }

    // Get server name (call getter every time — survives reload)
    const serverName = mcpHost.getToolServerMap().get(request.tool.name);
    const server = serverName ?? 'unknown';
    bus.emitToolStart(request.requestId, request.tool.name, server);

    // BUG 9: Inject _mcpl chain context for MCPL-aware servers
    let toolInput = request.tool.input;
    if (request.inferenceContext) {
      if (!serverName) {
        // Safe default: tool→server mapping stale/missing, skip injection
        console.debug('[MCPL] mcpl_context_not_injected_missing_server_mapping',
          { tool: request.tool.name, requestId: request.requestId.slice(0, 8) });
      } else {
        const serverConfig = config.mcp_servers?.find((s: { name: string }) => s.name === serverName);
        if (!serverConfig) {
          // Config doesn't have this server (stale config or name mismatch)
          console.debug('[MCPL] mcpl_context_not_injected_missing_server_config',
            { server: serverName, tool: request.tool.name, requestId: request.requestId.slice(0, 8) });
        }
        toolInput = maybeInjectMcpl(toolInput, request.inferenceContext, serverConfig?.acceptsMcplContext ?? false);
      }
    }

    try {
      const result = await mcpHost.callTool(request.tool.name, toolInput);
      // emitToolEnd AFTER confirmed send
      try {
        connection.sendToolCallResponse(
          request.requestId,
          request.tool.id,
          result.content,
          result.isError,
        );
        bus.emitToolEnd(request.requestId, result.content, result.isError ?? false);
      } catch (sendErr: any) {
        bus.emitToolEnd(request.requestId, result.content, result.isError ?? false);
        bus.pushError(`sendToolCallResponse failed: ${sendErr.message || String(sendErr)}`);
      }
    } catch (err: any) {
      bus.emitToolEnd(request.requestId, err, true);
      try {
        connection.sendToolCallResponse(
          request.requestId,
          request.tool.id,
          err instanceof Error ? err.message : 'Unknown error',
          true,
        );
      } catch (sendErr: any) {
        bus.pushError(`sendToolCallResponse failed: ${sendErr.message || String(sendErr)}`);
      }
    }
  });

  connection.on('error', (error: Error) => {
    bus.pushError(error.message);
  });

  connection.on('reconnecting', (attempt: number) => {
    bus.setReconnecting(attempt);
    bus.resetToFastTick();
  });

  connection.on('disconnected', (_code: number, _reason: string) => {
    bus.setConnectionState('disconnected');
    bus.resetToFastTick();
  });

  // Phase 7 Gap 6: Wire _scope_elevate virtual tool to connection
  mcpHost.setScopeElevateHandler(async (input) => {
    return new Promise((resolve) => {
      const requestId = randomUUID();

      // D-3: Wrap send in try/catch — if WS is disconnected, resolve with denied
      try {
        connection.sendScopeElevateRequest({
          requestId,
          delegateId: config.delegate.id,
          serverId: '',
          conversationId: '',
          featureSet: String(input.featureSet || ''),
          label: String(input.label || ''),
          requestedCapabilities: (input.capabilities as string[]) || [],
          reason: String(input.reason || ''),
        });
      } catch (err) {
        console.warn(`[Delegate] Scope elevate send failed: ${err instanceof Error ? err.message : String(err)}`);
        resolve({ approved: false });
        return;
      }

      // BUG-5 fix: clean up all listeners + timers on any resolution path
      const cleanup = () => {
        clearTimeout(timeout);
        connection.removeListener('mcpl_scope_elevate_result', handler);
        connection.removeListener('disconnected', onDisconnect);
      };

      const handler = (msg: any) => {
        if (msg.requestId === requestId) {
          cleanup();
          resolve({ approved: msg.approved, newCapabilities: msg.newCapabilities });
        }
      };

      const onDisconnect = () => {
        cleanup();
        resolve({ approved: false });
      };

      connection.on('mcpl_scope_elevate_result', handler);
      connection.once('disconnected', onDisconnect);

      const timeout = setTimeout(() => {
        cleanup();
        resolve({ approved: false });
      }, 65_000);
    });
  });

  // Connect to server
  await connection.connect();

  // ---- Reload MCP callback ----
  async function reloadMcp(): Promise<void> {
    if (bus.connectionState !== 'connected') {
      bus.setSetupStep('reload', 'error', 'Not connected');
      return;
    }
    if (bus.isReloading) return;

    bus.setReloading(true);
    try {
      if (bus.inFlightSize > 0) {
        bus.setSetupStep('reload', 'pending',
          `Waiting for ${bus.inFlightSize} in-flight calls...`);
        await waitForInflight(bus, DEFAULTS.RELOAD_WAIT_MS);
        if (bus.inFlightSize > 0) {
          bus.setSetupStep('reload', 'pending',
            `${bus.inFlightSize} calls still pending, forcing reload`);
        }
      }

      const freshConfig = loadConfig(findConfigPath(opts.config));
      mcpHost.setMcpConfigs(freshConfig.mcp_servers);
      await mcpHost.stopAll();
      await mcpHost.startAll(freshConfig.mcp_servers);
      // BUG-1 fix: update config AFTER servers are fully started.
      // Prevents race where tool_call_request reads new acceptsMcplContext
      // while servers are still restarting (between stopAll/startAll yields).
      config = freshConfig;

      const newTools = mcpHost.getAllToolsWithServer();
      connection.sendToolManifest(newTools, undefined, 'config_reload');
      bus.setTools(newTools.map(t => ({ name: t.name, server: (t as any).serverName || '' })));
      bus.setSetupStep('reload', 'ok', `${newTools.length} tools`);
    } catch (err: any) {
      bus.pushError(`Reload failed: ${err.message || String(err)}`);
    } finally {
      bus.setReloading(false);
    }
  }

  // ---- Webhook Server ----
  let webhookServer: WebhookServer | null = null;
  if (config.webhooks.enabled && config.webhooks.endpoints.length > 0) {
    webhookServer = new WebhookServer(connection, config.webhooks.rateLimits);
    webhookServer.start(config.webhooks.port, config.webhooks.endpoints);
  }

  // ---- U1: Stdin raw mode safety net ----
  const restoreStdin = () => {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {}
  };
  const uncaughtHandler = (err: Error) => {
    restoreStdin();
    process.stderr.write(`[Delegate] Uncaught: ${err.message}\n`);
    process.exit(1);
  };
  process.on('exit', restoreStdin);
  process.on('uncaughtException', uncaughtHandler);

  // ---- Graceful Shutdown ----
  let shuttingDown = false;

  async function shutdown(signal?: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    bus.destroy();  // U3: full cleanup — timers, listeners, buffers

    if (signal) process.stderr.write(`\n[Delegate] ${signal} received, shutting down...\n`);

    webhookServer?.stop();
    connection.disconnect();
    await mcpHost.stopAll();

    // U1: restore stdin and remove safety net listeners
    restoreStdin();
    process.off('exit', restoreStdin);
    process.off('uncaughtException', uncaughtHandler);

    process.stderr.write('[Delegate] Shutdown complete\n');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ---- Choose Renderer ----
  const useTui = process.stderr.isTTY
    && opts.tui !== false
    && !opts.quiet
    && process.env.TERM !== 'dumb';

  if (useTui) {
    try {
      const React = await import('react');
      const { render } = await import('ink');
      const { default: App } = await import('./tui/index.js');
      render(
        React.createElement(App, { bus, reload: reloadMcp, shutdown: () => shutdown() }),
        { stdout: process.stderr, stdin: process.stdin, exitOnCtrlC: false },
      );
    } catch (tuiErr) {
      process.stderr.write(`[Delegate] TUI failed to initialize, falling back to plain log: ${tuiErr instanceof Error ? tuiErr.message : String(tuiErr)}\n`);
      const { LogRenderer } = await import('./tui/log-renderer.js');
      new LogRenderer(bus);
    }
  } else {
    const { LogRenderer } = await import('./tui/log-renderer.js');
    new LogRenderer(bus);
  }
}

async function waitForInflight(bus: InstanceType<typeof import('./telemetry.js').TelemetryBus>, timeoutMs: number): Promise<boolean> {
  if (bus.inFlightSize === 0) return true;
  return new Promise(resolve => {
    const check = () => {
      if (bus.inFlightSize === 0) {
        bus.off('tool_call_end', check);
        clearTimeout(t);
        resolve(true);
      }
    };
    bus.on('tool_call_end', check);
    const t = setTimeout(() => {
      bus.off('tool_call_end', check);
      resolve(false);
    }, timeoutMs);
  });
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
