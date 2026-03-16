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
// H7: mcplState param updated — state/checkpoint now at top level per spec §8.4
export function maybeInjectMcpl(
  toolInput: Record<string, unknown>,
  inferenceContext: { chainId: string; frameId: string } | undefined,
  mcplState: { state: Record<string, unknown> | null; checkpoint?: string; stateVersion?: number } | undefined,
  acceptsMcplContext: boolean,
): Record<string, unknown> {
  if (!acceptsMcplContext) return toolInput;
  if (!inferenceContext && !mcplState) return toolInput;

  const mcplPayload: Record<string, unknown> = { v: 1 };
  if (inferenceContext) {
    mcplPayload.chainId = inferenceContext.chainId;
    mcplPayload.frameId = inferenceContext.frameId;
  }
  if (mcplState) {
    mcplPayload.state = mcplState.state;
    if (mcplState.checkpoint) mcplPayload.checkpoint = mcplState.checkpoint;
    if (mcplState.stateVersion !== undefined) mcplPayload.stateVersion = mcplState.stateVersion;
  }
  return {
    ...toolInput,
    _mcpl: mcplPayload,
  };
}

// =============================================================================
// CLI
// =============================================================================

const program = new Command()
  .name('animachat-delegate')
  .description('Animachat delegate - remote tool execution and MCP hosting')
  .version('1.0.0')
  .enablePositionalOptions()  // BUG 1 fix: stop parent from absorbing subcommand options
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
// BUG 2 fix: resolved config path from init → main() handoff
let resolvedConfigPath: string | undefined;

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
  const API_KEY_RE = /^dak_[A-Za-z0-9_-]{8,}$/;
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

        // BUG 6 fix: validate code parameter exists
        if (!code) {
          safeEnd(res, 400, '<html><body><h2>Missing authorization code</h2></body></html>');
          finalize({ success: false, error: 'Callback missing authorization code' });
          return;
        }

        // Success — show redirect page
        const safeFrontend = frontendUrl.replace(/"/g, '&quot;').replace(/</g, '&lt;');  // BUG 11 fix: escape URL
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="2;url=${safeFrontend}"></head><body><h2>✓ Authorized</h2><p>Redirecting to AnimaChat...</p></body></html>`);

        // Exchange code for API key (async, don't block response)
        exchangeCode(code);
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
          body: JSON.stringify({ code, code_verifier: codeVerifier, redirect_uri: redirectUri, state }),  // BUG 14+15 fix: RFC 6749 compliance
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
      if (!config.delegate.id) config.delegate.id = namespace;  // BUG 3 fix: preserve existing delegate.id
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
        resolvedConfigPath = configPath;  // BUG 2 fix: pass config path to main()
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
      resolvedConfigPath = configPath;  // BUG 2 fix: pass config path to main()
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

  // Load config — BUG 2 fix: prefer resolvedConfigPath from init "Start now"
  const configPath = findConfigPath(resolvedConfigPath || opts.config);
  let config = loadConfig(configPath);

  // Fix #3: Ensure all MCP servers have persistent IDs (auto-generate if missing)
  const { ensureServerIds } = await import('./config-utils.js');
  ensureServerIds(configPath, config.delegate.id);

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
  // M3 fix: wrap in try/catch to prevent cascade crash
  mcpHost.onServerDied = (name) => {
    try {
      bus.pushError(`MCP server "${name}" crashed`, name);
      handleToolsetChange('server_crashed', name);
    } catch (err) {
      console.error(`[Main] Error handling server crash for "${name}":`, err);
    }
  };

  // Feature 3: Notify server when toolset changes (enable/disable/restart/crash)
  mcpHost.onToolsetChanged = (reason, serverName) => {
    try {
      handleToolsetChange(reason, serverName);
    } catch (err) {
      console.error(`[Main] Error handling toolset change (${reason}, ${serverName}):`, err);
    }
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
          eventId: randomUUID(),
          featureSet: 'delegate',      // F8a: source → featureSet
          origin: { server: 'delegate' },  // spec: provenance metadata object
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
    mcplCapabilities: {              // H4 fix: spec §5.1 nested capabilities
      version: '0.4',
      pushEvents: true,
      contextHooks: {
        beforeInference: true,
        afterInference: { blocking: true },
      },
      inferenceRequest: { streaming: false },  // B2: chunks not forwarded yet, don't advertise
      modelInfo: true,
      featureSets: true,
      toolManagement: true,
    },
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

    // §5.3+§6.1: Send initial featureSets to backend so it knows what servers exist
    if (connection.isMcpl) {
      const featureSets = mcpHost.buildFeatureSets();
      const names = Object.keys(featureSets);
      // П3: Pre-populate before sendFeatureSetsChanged to close race window
      if (names.length > 0) {
        connection.prePopulateFeatureSets(names);
        connection.sendFeatureSetsChanged({ added: featureSets });
      }
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
        // H7: state/checkpoint now at request top level per spec §8.4
        const mcplStateForInject = request.state !== undefined ? {
          state: request.state,
          checkpoint: request.checkpoint,
          stateVersion: request.stateVersion,
        } : undefined;
        toolInput = maybeInjectMcpl(toolInput, request.inferenceContext, mcplStateForInject, serverConfig?.acceptsMcplContext ?? false);
      }
    }

    try {
      const result = await mcpHost.callTool(request.tool.name, toolInput, {
        // H7: forward MCPL state/checkpoint per spec §8.4
        state: request.state ?? undefined,
        checkpoint: request.checkpoint,
      });
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

  // ==========================================================================
  // Dynamic Server Addition: mcpl/connect_server
  //
  // Backend instructs delegate to connect a new MCP server at runtime (SSE).
  // Uses mcpHost.addServer() → sends connect_server_result → updates manifest
  // + featureSets.
  // ==========================================================================

  connection.on('mcpl_connect_server', async (msg: any) => {
    const url: string = msg.url;
    const serverName: string | undefined = msg.serverName;
    const requestId: string | undefined = msg.requestId;

    if (!url) {
      console.error('[Main] mcpl/connect_server missing url');
      if (requestId) {
        connection.sendConnectServerResult({
          requestId,
          url: '',
          success: false,
          error: 'Missing url in connect_server message',
        });
      }
      return;
    }

    console.log(`[Main] Dynamic server addition: ${serverName || url}`);

    try {
      const { tools } = await mcpHost.addServer(url, serverName);
      const name = serverName || new URL(url).hostname;

      // Send success result back to backend
      if (requestId) {
        connection.sendConnectServerResult({
          requestId,
          url,
          success: true,
          serverId: name,
          tools: tools.map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema,
          })),
        });
      }

      // Update tool manifest (triggers handleToolsetChange flow)
      handleToolsetChange('dynamic_server_added', name);

      // Update featureSets so backend knows about the new server's capabilities
      if (connection.isMcpl) {
        const newFeatureSet = mcpHost.buildFeatureSets();
        const added: Record<string, any> = {};
        if (newFeatureSet[name]) {
          added[name] = newFeatureSet[name];
        }
        if (Object.keys(added).length > 0) {
          connection.sendFeatureSetsChanged({ added });
        }
      }

      console.log(`[Main] Dynamic server "${name}" added successfully (${tools.length} tools)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Main] Dynamic server addition failed: ${errMsg}`);

      if (requestId) {
        connection.sendConnectServerResult({
          requestId,
          url,
          success: false,
          error: errMsg,
        });
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
        // Bug 3: Derive serverId from featureSet (featureSet name = server name in delegate)
        const featureSet = String(input.featureSet || '');
        connection.sendScopeElevateRequest({
          requestId,
          featureSet,
          scope: {
            label: String(input.label || ''),
            ...(input.payload ? { payload: input.payload as Record<string, unknown> } : {}),
          },
          delegateId: config.delegate.id,
          serverId: featureSet,  // Bug 3: featureSet = server name in delegate architecture
          conversationId: '',  // Bug 3: delegate doesn't own conversations; backend fills this
          requestedCapabilities: [],  // Bug 4: schema has no 'capabilities' field — always empty
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
          resolve({ approved: msg.approved, payload: msg.payload, reason: msg.reason });
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

  // ==========================================================================
  // MCPL Proxy: Wire _mcpl_* virtual tools to backend via pendingRequests
  //
  // MCP servers call _mcpl_inference_request, _mcpl_state_get, etc.
  // Delegate forwards to backend, waits for response, returns result.
  // ==========================================================================

  if (connection.isMcpl) {
    mcpHost.setMcplProxyHandler(async (method: string, input: Record<string, unknown>) => {
      const requestId = randomUUID();

      switch (method) {
        case '_mcpl_inference_request': {
          // Bug 6: Reject stream:true — chunks not forwarded yet (B2: streaming: false in caps)
          if (input.stream === true) {
            throw new Error('Streaming inference not supported yet. Use stream: false.');
          }
          const pending = registerPendingRequest(requestId, 120_000); // inference can be slow
          connection.sendInferenceRequest({
            requestId,
            featureSet: String(input.featureSet || ''),
            conversationId: String(input.conversationId || ''),
            stream: false,  // Bug 6: always non-streaming until chunk forwarding is implemented
            messages: (input.messages as Array<{ role: 'user' | 'assistant'; content: string }>) || [],
            preferences: {
              ...(input.maxTokens ? { maxTokens: Number(input.maxTokens) } : {}),
              ...(input.temperature != null ? { temperature: Number(input.temperature) } : {}),
            },
          });
          return await pending;
        }

        case '_mcpl_state_get': {
          const pending = registerPendingRequest(requestId, 30_000);
          connection.sendStateGet(requestId, String(input.conversationId || ''));
          return await pending;
        }

        case '_mcpl_state_patch': {
          const pending = registerPendingRequest(requestId, 30_000);
          connection.sendStatePatch(
            requestId,
            String(input.conversationId || ''),
            (input.patch as unknown[]) || [],
          );
          return await pending;
        }

        case '_mcpl_state_rollback': {
          const pending = registerPendingRequest(requestId, 30_000);
          connection.sendStateRollback(
            requestId,
            String(input.featureSet || ''),
            String(input.checkpoint || ''),
          );
          return await pending;
        }

        case '_mcpl_checkpoint_list': {
          const pending = registerPendingRequest(requestId, 30_000);
          connection.sendCheckpointList(requestId, String(input.conversationId || ''));
          return await pending;
        }

        case '_mcpl_model_info': {
          const pending = registerPendingRequest(requestId, 10_000);
          connection.sendModelInfoRequest(requestId, input.conversationId ? String(input.conversationId) : undefined);
          return await pending;
        }

        default:
          throw new Error(`Unknown MCPL proxy method: ${method}`);
      }
    });
  }

  // ==========================================================================
  // §10: Context Hook Forwarding (beforeInference / afterInference)
  //
  // Backend sends hooks → delegate → local MCP servers (that opt in).
  // Delegate aggregates responses and sends back to backend.
  // Fail-open: timeout or error → proceed without that server's contribution.
  // ==========================================================================

  /** §10.6: Per-server timeout for beforeInference forwarding (spec recommends 5s total, we use 4s per server) */
  const BEFORE_INFERENCE_TIMEOUT_MS = 4_000;
  /** §10.6: Per-server timeout for afterInference blocking (spec recommends 10s total, we use 8s per server) */
  const AFTER_INFERENCE_TIMEOUT_MS = 8_000;

  /**
   * §10.1-10.2: Forward beforeInference to hook-capable MCP servers.
   * Sends context/beforeInference request to each, aggregates contextInjections.
   * Fail-open: any server timeout/error is logged but doesn't block the response.
   */
  connection.on('mcpl_before_inference', async (msg: any) => {
    const hookServers = mcpHost.getBeforeInferenceServers();

    if (hookServers.length === 0) {
      // No hook-capable servers — respond with empty injections
      connection.sendBeforeInferenceResponse(msg.requestId, []);
      return;
    }

    // Forward to all servers in parallel with per-server timeout
    // B1 fix: content supports string | ContentBlock[] per spec §10.3
    const allInjections: Array<{
      namespace: string;
      position: 'system' | 'beforeUser' | 'afterUser';
      content: string | import('./mcpl-types.js').McplContentBlock[];
      metadata?: Record<string, unknown>;
    }> = [];
    let aggregatedAbort = false;
    let aggregatedAbortReason: string | undefined;

    const hookParams = {
      inferenceId: msg.inferenceId || msg.requestId,
      conversationId: msg.conversationId,
      turnIndex: msg.turnIndex,
      userMessage: msg.userMessage ?? null,
      model: msg.model,
    };

    const results = await Promise.allSettled(
      hookServers.map(async ({ name, client }) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), BEFORE_INFERENCE_TIMEOUT_MS);
        try {
          // Send context/beforeInference as JSON-RPC request via MCP transport
          const result = await (client as any).request(
            { method: 'context/beforeInference', params: hookParams },
            { parse: (v: unknown) => v },  // passthrough schema — accept any result
            { signal: abortController.signal, timeout: BEFORE_INFERENCE_TIMEOUT_MS + 500 },
          ) as Record<string, unknown>;
          clearTimeout(timer);

          // B3: Check abort flag (spec §10.2)
          if (result?.abort === true && !aggregatedAbort) {
            aggregatedAbort = true;
            aggregatedAbortReason = typeof result.abortReason === 'string'
              ? result.abortReason : `Aborted by ${name}`;
            console.warn(`[Hooks] beforeInference abort from "${name}": ${aggregatedAbortReason}`);
          }

          // Extract contextInjections from result (spec §10.2)
          const injections = result?.contextInjections;
          if (Array.isArray(injections)) {
            for (const inj of injections) {
              if (inj && typeof inj === 'object' && typeof (inj as any).namespace === 'string') {
                // B1: Preserve content type — pass through string or ContentBlock[]
                const rawContent = (inj as any).content;
                const content = (typeof rawContent === 'string' || Array.isArray(rawContent))
                  ? rawContent : '';
                allInjections.push({
                  namespace: (inj as any).namespace,
                  position: (inj as any).position || 'system',
                  content,
                  ...((inj as any).metadata ? { metadata: (inj as any).metadata } : {}),
                });
              }
            }
          }
          return { server: name, featureSet: result?.featureSet };
        } catch (err) {
          clearTimeout(timer);
          const errMsg = err instanceof Error ? err.message : String(err);
          // §10.6: fail-open — log and continue without this server's contribution
          console.warn(`[Hooks] beforeInference timeout/error from "${name}": ${errMsg}`);
          return { server: name, error: errMsg };
        }
      })
    );

    // §10.8: Sort injections by namespace for deterministic ordering
    allInjections.sort((a, b) => a.namespace.localeCompare(b.namespace));

    // Log aggregated result
    const succeeded = results.filter(r => r.status === 'fulfilled' && !(r.value as any).error).length;
    if (allInjections.length > 0 || hookServers.length > 1) {
      console.log(`[Hooks] beforeInference: ${succeeded}/${hookServers.length} servers, ${allInjections.length} injection(s)`);
    }

    // Send aggregated response back to backend (B3: include abort if any server requested it)
    connection.sendBeforeInferenceResponse(msg.requestId, allInjections, undefined, aggregatedAbort, aggregatedAbortReason);
  });

  /**
   * §10.5: Forward afterInference to hook-capable MCP servers.
   * - Non-blocking servers: fire-and-forget notification (no response expected)
   * - Blocking servers: send request and wait for response (may modify response)
   * Ack is sent immediately after blocking servers respond (or timeout).
   */
  connection.on('mcpl_after_inference', async (msg: any) => {
    const hookServers = mcpHost.getAfterInferenceServers();

    if (hookServers.length === 0) {
      // No hook-capable servers — send ack immediately
      try {
        connection.send({ type: 'mcpl/afterInference_ack', requestId: msg.requestId });
      } catch { /* ignore */ }
      return;
    }

    const hookParams = {
      inferenceId: msg.inferenceId || msg.requestId,
      conversationId: msg.conversationId,
      turnIndex: msg.turnIndex,
      userMessage: msg.userMessage ?? null,
      assistantMessage: msg.assistantMessage ?? null,
      model: msg.model,
      usage: msg.usage,
    };

    // Separate blocking vs non-blocking servers
    // B5: Sort by server name for deterministic modifiedResponse ordering (last-write-wins)
    const blockingServers = hookServers.filter(s => s.blocking).sort((a, b) => a.name.localeCompare(b.name));
    const nonBlockingServers = hookServers.filter(s => !s.blocking);

    // L2: Fire-and-forget for non-blocking servers — parallel, not sequential
    await Promise.allSettled(nonBlockingServers.map(({ name, client }) =>
      (client as any).notification(
        { method: 'context/afterInference', params: hookParams },
      ).catch((err: unknown) => {
        console.warn(`[Hooks] afterInference notification to "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      })
    ));

    // For blocking servers: send request, wait for response, may get modifiedResponse
    if (blockingServers.length === 0) {
      // All servers non-blocking — send ack
      try {
        connection.send({ type: 'mcpl/afterInference_ack', requestId: msg.requestId });
      } catch { /* ignore */ }
      return;
    }

    // Forward to blocking servers in parallel with timeout
    let modifiedResponse: string | undefined;
    let responseFeatureSet: string | undefined;
    let responseMetadata: Record<string, unknown> | undefined;

    const results = await Promise.allSettled(
      blockingServers.map(async ({ name, client }) => {
        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), AFTER_INFERENCE_TIMEOUT_MS);
        try {
          const result = await (client as any).request(
            { method: 'context/afterInference', params: hookParams },
            { parse: (v: unknown) => v },  // passthrough schema
            { signal: abortController.signal, timeout: AFTER_INFERENCE_TIMEOUT_MS + 500 },
          ) as Record<string, unknown>;
          clearTimeout(timer);

          // §10.5: blocking afterInference can return modifiedResponse
          if (typeof result?.modifiedResponse === 'string') {
            // Last-write-wins if multiple blocking servers modify response
            modifiedResponse = result.modifiedResponse;
            responseFeatureSet = result.featureSet as string | undefined;
            responseMetadata = result.metadata as Record<string, unknown> | undefined;
          }
          return { server: name, modified: !!result?.modifiedResponse };
        } catch (err) {
          clearTimeout(timer);
          // §10.6: fail-open — timeout/error means proceed without modification
          console.warn(`[Hooks] afterInference timeout/error from "${name}": ${err instanceof Error ? err.message : String(err)}`);
          return { server: name, error: true };
        }
      })
    );

    const succeeded = results.filter(r => r.status === 'fulfilled' && !(r.value as any).error).length;
    console.log(`[Hooks] afterInference: ${succeeded}/${blockingServers.length} blocking, ${nonBlockingServers.length} non-blocking`);

    // Send response (full response if any server modified, otherwise ack)
    if (modifiedResponse !== undefined) {
      connection.sendAfterInferenceResponse(msg.requestId, {
        modifiedResponse,
        featureSet: responseFeatureSet,
        metadata: responseMetadata,
      });
    } else {
      try {
        connection.send({ type: 'mcpl/afterInference_ack', requestId: msg.requestId });
      } catch { /* ignore */ }
    }
  });

  // ==========================================================================
  // MCPL Response Handlers
  //
  // These events are emitted by connection.ts when the backend sends responses
  // to requests the delegate (or its MCP servers) initiated. A pending-request
  // Map correlates requestId → resolve/reject so callers get their answer.
  // ==========================================================================

  /** Pending request store: requestId → { resolve, reject, timer } */
  const pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  /** Register a pending request with timeout. Returns a promise that resolves when the response arrives. */
  function registerPendingRequest(requestId: string, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error(`MCPL request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pendingRequests.set(requestId, { resolve, reject, timer });
    });
  }

  /** Resolve a pending request by requestId. Returns true if found. */
  function resolvePendingRequest(requestId: string | undefined, data: any): boolean {
    if (!requestId) return false;
    const pending = pendingRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingRequests.delete(requestId);
    pending.resolve(data);
    return true;
  }

  // §6.7: featureSets_update — backend changes which featureSets are enabled/disabled
  // connection.ts already updates _enabledFeatureSets; B4: also notify MCP servers
  connection.on('mcpl_featureSets_update', (msg: any) => {
    const enabled: string[] = msg.enabled || [];
    const disabled: string[] = msg.disabled || [];
    console.log(`[Main] featureSets/update: enabled=[${enabled.join(', ')}], disabled=[${disabled.join(', ')}]`);

    // Bug 2: Include scopes (whitelist/blacklist) in forwarded notification
    const scopes = msg.scopes || undefined;
    if (scopes) {
      console.log(`[Main] featureSets/update includes scopes for ${Object.keys(scopes).length} featureSet(s)`);
    }

    // B4: Forward to MCP servers as JSON-RPC notification (best-effort)
    for (const server of mcpHost.allServers.values()) {
      try {
        (server.client as any).notification?.({
          method: 'featureSets/update',
          params: { enabled, disabled, ...(scopes ? { scopes } : {}) },
        });
      } catch {
        // MCP servers may not handle this notification — that's OK
      }
    }
  });

  // §11: inference_response — backend returns inference result
  connection.on('mcpl_inference_response', (msg: any) => {
    if (!resolvePendingRequest(msg.requestId, msg)) {
      console.warn(`[Main] Unmatched inference_response (requestId: ${msg.requestId})`);
    }
  });

  // §11: inference_chunk — backend streams inference chunks
  connection.on('mcpl_inference_chunk', (msg: any) => {
    // Chunks don't resolve the request — they're intermediate.
    // Forward to a chunk callback if registered.
    const pending = pendingRequests.get(msg.requestId);
    if (!pending) {
      console.warn(`[Main] Unmatched inference_chunk (requestId: ${msg.requestId})`);
    }
    // TODO: when MCP servers support streaming inference, forward chunks here
  });

  // §8: state_response — backend returns state data (state_get or state_rollback result)
  connection.on('mcpl_state_response', (msg: any) => {
    if (!resolvePendingRequest(msg.requestId, msg)) {
      console.warn(`[Main] Unmatched state_response (requestId: ${msg.requestId})`);
    }
  });

  // §8: state_patch_result — backend confirms state patch applied
  connection.on('mcpl_state_patch_result', (msg: any) => {
    if (!resolvePendingRequest(msg.requestId, msg)) {
      console.warn(`[Main] Unmatched state_patch_result (requestId: ${msg.requestId})`);
    }
  });

  // §8: checkpoint_list_response — backend returns checkpoint tree
  connection.on('mcpl_checkpoint_list_response', (msg: any) => {
    if (!resolvePendingRequest(msg.requestId, msg)) {
      console.warn(`[Main] Unmatched checkpoint_list_response (requestId: ${msg.requestId})`);
    }
  });

  // §9: push_event_response — backend accepted/denied push event
  connection.on('mcpl_push_event_response', (msg: any) => {
    const status = msg.accepted ? 'accepted' : `denied: ${msg.reason || 'unknown'}`;
    console.log(`[Main] Push event ${msg.requestId}: ${status}`);
    resolvePendingRequest(msg.requestId, msg);
  });

  // §7: scope_change_result — backend approved/denied scope change
  connection.on('mcpl_scope_change_result', (msg: any) => {
    if (!resolvePendingRequest(msg.requestId, msg)) {
      console.log(`[Main] Scope change ${msg.requestId}: ${msg.approved ? 'approved' : 'denied'}`);
    }
  });

  // §12: model_info_response — backend returns model metadata
  connection.on('mcpl_model_info_response', (msg: any) => {
    if (!resolvePendingRequest(msg.requestId, msg)) {
      console.warn(`[Main] Unmatched model_info_response (requestId: ${msg.requestId})`);
    }
  });

  // §5: tool_manifest_ack — backend confirmed tool manifest receipt
  connection.on('tool_manifest_ack', (msg: any) => {
    console.log(`[Main] Tool manifest acknowledged (${msg.toolCount ?? '?'} tools)`);
    if (msg.warnings?.length) {
      for (const w of msg.warnings) {
        console.warn(`[Main] Tool rejected: "${w.toolName}" — ${w.reason}`);
      }
    }
  });

  // §11: trigger_inference_result — backend confirmed trigger inference
  connection.on('trigger_inference_result', (msg: any) => {
    if (!resolvePendingRequest(msg.requestId, msg)) {
      console.log(`[Main] Trigger inference result: ${msg.success ? 'ok' : msg.error || 'failed'}`);
    }
  });

  // §15: mcpl_error — protocol-level error from backend
  connection.on('mcpl_error', (msg: any) => {
    const inReplyTo = msg.inReplyTo?.type || msg.inReplyTo?.requestId;
    console.error(`[Main] MCPL error: code=${msg.code} "${msg.message}"${inReplyTo ? ` (re: ${inReplyTo})` : ''}`);

    // Try to reject the pending request that caused this error
    if (msg.inReplyTo?.requestId) {
      const pending = pendingRequests.get(msg.inReplyTo.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.inReplyTo.requestId);
        pending.reject(new Error(`MCPL error ${msg.code}: ${msg.message}`));
      }
    }
  });

  // Connection state changes (informational)
  connection.on('state_change', (newState: string) => {
    console.log(`[Main] Connection state: ${newState}`);
  });

  // Clean up pending requests on disconnect
  connection.on('disconnected', () => {
    if (pendingRequests.size > 0) {
      console.log(`[Main] Clearing ${pendingRequests.size} pending MCPL request(s) on disconnect`);
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Disconnected'));
      }
      pendingRequests.clear();
    }
  });

  // Export registerPendingRequest for use by MCP server request forwarding
  (connection as any)._registerPendingRequest = registerPendingRequest;

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

      const freshConfig = loadConfig(findConfigPath(configPath));
      mcpHost.setMcpConfigs(freshConfig.mcp_servers);
      await mcpHost.stopAll();
      await mcpHost.startAll(freshConfig.mcp_servers);
      // BUG-1 fix: update config AFTER servers are fully started.
      // Prevents race where tool_call_request reads new acceptsMcplContext
      // while servers are still restarting (between stopAll/startAll yields).
      config = freshConfig;

      const newTools = mcpHost.getAllToolsWithServer();
      connection.sendToolManifest(newTools, undefined, 'config_reload');
      // §6.1: Update featureSets after reload (full replacement via added)
      if (connection.isMcpl) {
        const featureSets = mcpHost.buildFeatureSets();
        connection.sendFeatureSetsChanged({ added: featureSets });
      }
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
