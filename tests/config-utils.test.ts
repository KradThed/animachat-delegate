import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import YAML from 'yaml';
import {
  readConfigRaw,
  writeConfigRaw,
  updateConfig,
  maskApiKey,
  deriveHttpUrl,
  deriveWsUrl,
} from '../src/config-utils.js';

// ─── maskApiKey ──────────────────────────────────────────────────

describe('maskApiKey', () => {
  it('returns "(not set)" for undefined', () => {
    expect(maskApiKey(undefined)).toBe('(not set)');
  });

  it('returns "(not set)" for empty string', () => {
    expect(maskApiKey('')).toBe('(not set)');
  });

  it('returns "***" for short tokens (length <= 12)', () => {
    expect(maskApiKey('short')).toBe('***');
  });

  it('returns "***" for exactly 12 characters', () => {
    expect(maskApiKey('abcdefghijkl')).toBe('***'); // length === 12, not > 12
  });

  it('masks token with length 13 (first 8 + ... + last 4)', () => {
    // 'abcdefghijklm' has 13 chars
    // substring(0, 8) = 'abcdefgh'
    // substring(13 - 4) = substring(9) = 'jklm'
    expect(maskApiKey('abcdefghijklm')).toBe('abcdefgh...jklm');
  });

  it('masks token with length 14 (first 8 + ... + last 4)', () => {
    // 'exactly12chars' has 14 chars — typo in name notwithstanding
    // substring(0, 8) = 'exactly1'
    // substring(14 - 4) = substring(10) = 'hars'
    expect(maskApiKey('exactly12chars')).toBe('exactly1...hars');
  });

  it('masks a real dak_ API key correctly', () => {
    const token = 'dak_c2ldRoG4_vX5BG3tJZgzdZZsJm21sHXvUFVgJpowHmw';
    // first 8 = 'dak_c2ld'
    // last 4 = 'wHmw' (token ends with ...JpowHmw)
    expect(maskApiKey(token)).toBe('dak_c2ld...wHmw');
  });
});

// ─── deriveHttpUrl ───────────────────────────────────────────────

describe('deriveHttpUrl', () => {
  it('converts ws:// to http://', () => {
    expect(deriveHttpUrl('ws://localhost:3010')).toBe('http://localhost:3010');
  });

  it('converts wss:// to https://', () => {
    expect(deriveHttpUrl('wss://example.com')).toBe('https://example.com');
  });

  it('leaves http:// unchanged (no ws prefix to match)', () => {
    expect(deriveHttpUrl('http://already.com')).toBe('http://already.com');
  });

  it('leaves https:// unchanged', () => {
    expect(deriveHttpUrl('https://secure.com')).toBe('https://secure.com');
  });

  it('preserves path and query string after conversion', () => {
    expect(deriveHttpUrl('wss://example.com/path?key=val')).toBe(
      'https://example.com/path?key=val',
    );
  });
});

// ─── deriveWsUrl ─────────────────────────────────────────────────

describe('deriveWsUrl', () => {
  it('converts https:// to wss://', () => {
    expect(deriveWsUrl('https://example.com')).toBe('wss://example.com');
  });

  it('converts http:// to ws://', () => {
    expect(deriveWsUrl('http://localhost')).toBe('ws://localhost');
  });

  it('leaves ws:// unchanged', () => {
    expect(deriveWsUrl('ws://already.com')).toBe('ws://already.com');
  });

  it('leaves wss:// unchanged', () => {
    expect(deriveWsUrl('wss://secure.com')).toBe('wss://secure.com');
  });

  it('preserves path and query string after conversion', () => {
    expect(deriveWsUrl('https://example.com/ws?token=abc')).toBe(
      'wss://example.com/ws?token=abc',
    );
  });
});

// ─── readConfigRaw / writeConfigRaw / updateConfig ───────────────

describe('readConfigRaw', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-utils-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a valid YAML file', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    const configData = { serverUrl: 'ws://localhost:3010', apiKey: 'test-key' };
    writeFileSync(configPath, YAML.stringify(configData), 'utf-8');

    const result = readConfigRaw(configPath);
    expect(result.data).toEqual(configData);
    expect(result.path).toBe(configPath);
  });

  it('returns {} for an empty YAML file', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    writeFileSync(configPath, '', 'utf-8');

    const result = readConfigRaw(configPath);
    expect(result.data).toEqual({});
  });

  it('returns {} for a YAML file containing only whitespace', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    writeFileSync(configPath, '   \n\n  ', 'utf-8');

    const result = readConfigRaw(configPath);
    expect(result.data).toEqual({});
  });

  it('throws when explicit path does not exist', () => {
    const nonExistentPath = join(tmpDir, 'nonexistent.yaml');
    expect(() => readConfigRaw(nonExistentPath)).toThrowError(
      'No config file found. Run "animachat-delegate init" first.',
    );
  });

  it('throws with "Failed to parse" on invalid YAML', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    // Write content that YAML.parse will reject — a tab character in an indentation-sensitive position
    writeFileSync(configPath, ':\n  :\n    - :\n      {{{invalid', 'utf-8');

    expect(() => readConfigRaw(configPath)).toThrowError(/Failed to parse/);
  });

  it('preserves complex nested YAML structures', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    const complexData = {
      serverUrl: 'wss://prod.example.com',
      capabilities: ['mcp_host', 'tool_runner'],
      nested: { deep: { value: 42, list: [1, 2, 3] } },
    };
    writeFileSync(configPath, YAML.stringify(complexData), 'utf-8');

    const result = readConfigRaw(configPath);
    expect(result.data).toEqual(complexData);
  });
});

describe('writeConfigRaw', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-utils-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes config as valid YAML to the specified path', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    const config = { serverUrl: 'ws://localhost:3010', apiKey: 'test-key' };

    writeConfigRaw(configPath, config);

    expect(existsSync(configPath)).toBe(true);
    const written = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(written);
    expect(parsed).toEqual(config);
  });

  it('uses atomic write via tmp file + rename (tmp file is cleaned up)', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    const tmpPath = configPath + '.tmp';

    writeConfigRaw(configPath, { key: 'value' });

    // The final file should exist
    expect(existsSync(configPath)).toBe(true);
    // The tmp file should have been renamed away (no longer exists)
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('overwrites an existing config file', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    writeFileSync(configPath, YAML.stringify({ old: 'data' }), 'utf-8');

    const newConfig = { new: 'data', version: 2 };
    writeConfigRaw(configPath, newConfig);

    const written = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(written);
    expect(parsed).toEqual(newConfig);
  });

  it('handles empty object config', () => {
    const configPath = join(tmpDir, 'delegate.yaml');

    writeConfigRaw(configPath, {});

    expect(existsSync(configPath)).toBe(true);
    const written = readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(written);
    // YAML.stringify({}) -> '{}\n', YAML.parse('{}\n') -> {}
    expect(parsed).toEqual({});
  });
});

describe('updateConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'config-utils-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('performs a read-modify-write cycle correctly', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    const initialConfig = { serverUrl: 'ws://localhost:3010', apiKey: 'old-key' };
    writeFileSync(configPath, YAML.stringify(initialConfig), 'utf-8');

    updateConfig(configPath, (config) => {
      config.apiKey = 'new-key';
    });

    const result = readConfigRaw(configPath);
    expect(result.data.apiKey).toBe('new-key');
    expect(result.data.serverUrl).toBe('ws://localhost:3010');
  });

  it('adds new properties via the mutation function', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    writeFileSync(configPath, YAML.stringify({ serverUrl: 'ws://localhost:3010' }), 'utf-8');

    updateConfig(configPath, (config) => {
      config.newProp = 'added';
      config.nested = { deep: true };
    });

    const result = readConfigRaw(configPath);
    expect(result.data.newProp).toBe('added');
    expect(result.data.nested).toEqual({ deep: true });
  });

  it('deletes properties via the mutation function', () => {
    const configPath = join(tmpDir, 'delegate.yaml');
    writeFileSync(
      configPath,
      YAML.stringify({ serverUrl: 'ws://localhost:3010', removeMe: 'bye' }),
      'utf-8',
    );

    updateConfig(configPath, (config) => {
      delete config.removeMe;
    });

    const result = readConfigRaw(configPath);
    expect(result.data.removeMe).toBeUndefined();
    expect(result.data.serverUrl).toBe('ws://localhost:3010');
  });

  it('creates default config when file does not exist (M2: first-run safe)', () => {
    const nonExistentPath = join(tmpDir, 'missing.yaml');
    // M2: updateConfig now creates a default config instead of throwing
    updateConfig(nonExistentPath, (cfg) => {
      cfg.greeting = 'hello';
    });
    const result = readConfigRaw(nonExistentPath);
    expect(result.data.mcp_servers).toEqual([]);
    expect(result.data.greeting).toBe('hello');
  });
});
