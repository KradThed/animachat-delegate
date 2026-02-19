/**
 * Shared defaults and constants for the delegate CLI.
 */

export const DEFAULTS = {
  serverUrl: 'ws://localhost:3010',   // ws:// is canonical (delegate's primary job = WS)
  configFile: 'delegate.yaml',
  loginTimeout: 120_000,              // 2 minutes
  capabilities: ['mcp_host'] as const,
  RELOAD_WAIT_MS: 5_000,
};

export const CONFIG_SEARCH_PATHS = [
  'delegate.yaml',
  'delegate.yml',
  'config/delegate.yaml',
  'config/delegate.yml',
];
