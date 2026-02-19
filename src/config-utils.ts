/**
 * Config file utilities for delegate CLI.
 * readConfigRaw / writeConfigRaw / updateConfig — used by mcp and config subcommands.
 * writeConfigYaml stays in index.ts (used by loginFlow directly).
 */

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, openSync, closeSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import YAML from 'yaml';
import { CONFIG_SEARCH_PATHS } from './constants.js';

/**
 * Read delegate.yaml as raw parsed YAML (no Zod validation).
 * Searches default paths if no explicit path given.
 */
export function readConfigRaw(configPath?: string): { path: string; data: any } {
  const candidates = configPath ? [configPath] : CONFIG_SEARCH_PATHS;

  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      try {
        const raw = readFileSync(resolved, 'utf-8');
        return { path: resolved, data: YAML.parse(raw) || {} };
      } catch (err: any) {
        throw new Error(`Failed to parse ${resolved}: ${err.message}`);
      }
    }
  }

  throw new Error('No config file found. Run "animachat-delegate init" first.');
}

/**
 * Write raw config object to delegate.yaml atomically (temp + rename + chmod 600).
 * path + '.tmp' guarantees same filesystem for atomic rename.
 */
export function writeConfigRaw(configPath: string, config: any): void {
  const yaml = YAML.stringify(config);
  const tmpPath = configPath + '.tmp';
  writeFileSync(tmpPath, yaml, 'utf-8');

  if (process.platform !== 'win32') {
    try { chmodSync(tmpPath, 0o600); } catch {}
  }

  renameSync(tmpPath, configPath);
}

// M4: Lock file for TOCTOU protection on concurrent config updates
const LOCK_STALE_MS = 30_000;
const LOCK_MAX_RETRIES = 3;

function withLock<T>(configPath: string, fn: () => T): T {
  const lockPath = configPath + '.lock';

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, 'wx');
    } catch {
      // Lock exists — check if stale
      try {
        const lockContent = readFileSync(lockPath, 'utf-8');
        const lockTime = parseInt(lockContent.split(':')[1] || '0', 10);
        if (Date.now() - lockTime > LOCK_STALE_MS) {
          // Stale lock — remove and retry
          try { unlinkSync(lockPath); } catch {}
          continue;
        }
      } catch {
        // Can't read lock — might have been removed, retry
        continue;
      }
      throw new Error('Config file locked by another process. Try again.');
    }

    try {
      // Write pid:timestamp to lock file
      writeFileSync(lockPath, `${process.pid}:${Date.now()}`, 'utf-8');
      return fn();
    } finally {
      if (fd !== null) try { closeSync(fd); } catch {}
      try { unlinkSync(lockPath); } catch {}
    }
  }

  throw new Error('Failed to acquire config lock after retries.');
}

/**
 * Read-modify-write helper. Atomic: reads config, applies fn, writes back.
 * M2: Falls back to default structure if no config exists (first-run safe).
 * M4: Uses lock file to prevent TOCTOU race conditions.
 */
export function updateConfig(configPath: string | undefined, fn: (config: any) => void): void {
  // Resolve path once (outside lock — just path resolution)
  let resolvedPath: string;
  try {
    const result = readConfigRaw(configPath);
    resolvedPath = result.path;
  } catch {
    // M2: first run — pick first candidate path
    const candidates = configPath ? [configPath] : CONFIG_SEARCH_PATHS;
    resolvedPath = resolve(candidates[0]);
  }

  withLock(resolvedPath, () => {
    // Re-read inside lock to get latest state
    let data: any;
    try {
      const fresh = readConfigRaw(configPath);
      data = fresh.data;
    } catch {
      // M2: first run — create with default structure
      data = { mcp_servers: [] };
    }
    fn(data);
    writeConfigRaw(resolvedPath, data);
  });
}

/**
 * Mask API key for display: first 8 chars + '...' + last 4 chars.
 */
export function maskApiKey(token: string | undefined): string {
  if (!token) return '(not set)';
  if (token.length > 12) {
    return token.substring(0, 8) + '...' + token.substring(token.length - 4);
  }
  return '***';
}

/**
 * Derive HTTP base URL from ws:// canonical URL.
 */
export function deriveHttpUrl(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/**
 * Derive WS URL from any URL format (idempotent if already ws://).
 */
export function deriveWsUrl(url: string): string {
  return url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

// =============================================================================
// Fix #3: Server ID Persistence
// =============================================================================

/**
 * Generate a deterministic server ID from namespace + name + command.
 * Produces a stable ID that survives delegate restarts.
 * Format: srv_ + first 16 hex chars of SHA-256.
 */
export function deterministicServerId(namespace: string, name: string, command: string): string {
  const input = `${namespace}:${name}:${command}`;
  const hash = createHash('sha256').update(input).digest('hex');
  return `srv_${hash.substring(0, 16)}`;
}

/**
 * Ensure all MCP servers in config have a persistent ID.
 * Missing IDs are generated deterministically and written back atomically.
 * Idempotent: if all servers already have IDs, no write occurs.
 */
export function ensureServerIds(configPath: string | undefined, delegateId: string): void {
  const { path: resolvedPath, data } = readConfigRaw(configPath);

  if (!data.mcp_servers || !Array.isArray(data.mcp_servers)) return;

  let modified = false;
  for (const server of data.mcp_servers) {
    if (!server.id) {
      server.id = deterministicServerId(delegateId, server.name, server.command);
      modified = true;
    }
  }

  if (modified) {
    writeConfigRaw(resolvedPath, data);
    console.log(`[Config] Generated persistent server IDs for ${data.mcp_servers.filter((s: any) => s.id).length} server(s)`);
  }
}
