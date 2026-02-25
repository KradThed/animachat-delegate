import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Shared holder for real and swappable implementations.
// `vi.mock` is hoisted, so only `const` initializations available at hoist time
// can be referenced inside the factory. We store everything in this object.
const fsMocks = {
  realExistsSync: null as unknown as typeof import('fs').existsSync,
  realReadFileSync: null as unknown as typeof import('fs').readFileSync,
  existsSyncImpl: null as unknown as typeof import('fs').existsSync,
  readFileSyncImpl: null as unknown as typeof import('fs').readFileSync,
};

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();

  // Capture real implementations
  fsMocks.realExistsSync = actual.existsSync;
  fsMocks.realReadFileSync = actual.readFileSync;

  // Default to real
  fsMocks.existsSyncImpl = actual.existsSync;
  fsMocks.readFileSyncImpl = actual.readFileSync;

  return {
    ...actual,
    existsSync: (...args: Parameters<typeof actual.existsSync>) =>
      fsMocks.existsSyncImpl(...args),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      fsMocks.readFileSyncImpl(...args),
  };
});

// Import after vi.mock so the mock is in effect for the module under test.
const { loadConfig, findConfigPath } = await import('../src/config.js');

// We need the real fs functions for test setup (creating temp dirs/files).
// These are grabbed from the fsMocks holder after the mock factory has run.
const { mkdtempSync, writeFileSync, rmSync } = await import('fs').then(
  (mod) => ({
    // These come from the spread `...actual`, so they are the real functions.
    mkdtempSync: fsMocks.realReadFileSync ? mod.mkdtempSync : mod.mkdtempSync,
    writeFileSync: mod.writeFileSync,
    rmSync: mod.rmSync,
  })
);

// ─── loadConfig ──────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    // Reset to real implementations for loadConfig tests (uses real files)
    fsMocks.existsSyncImpl = fsMocks.realExistsSync;
    fsMocks.readFileSyncImpl = fsMocks.realReadFileSync;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper: write a YAML file and return its absolute path. */
  function writeYaml(filename: string, content: string): string {
    const filePath = path.join(tmpDir, filename);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // ── 1. Valid YAML with defaults ──

  it('returns typed config with defaults applied for minimal valid YAML', () => {
    const configPath = writeYaml('delegate.yaml', `
server:
  url: "wss://example.com/ws"
  token: "my-token"
delegate:
  id: "delegate-1"
`);

    const config = loadConfig(configPath);

    expect(config.server.url).toBe('wss://example.com/ws');
    expect(config.server.token).toBe('my-token');
    expect(config.delegate.id).toBe('delegate-1');
    // Defaults from schema
    expect(config.delegate.capabilities).toEqual(['mcp_host']);
    expect(config.mcp_servers).toEqual([]);
    expect(config.webhooks).toEqual({
      enabled: false,
      port: 8080,
      endpoints: [],
      rateLimits: { windowMs: 60_000, maxPerWindow: 60 },
    });
  });

  it('returns full config when all fields are provided', () => {
    const configPath = writeYaml('full.yaml', `
server:
  url: "wss://example.com/ws"
  token: "tok"
delegate:
  id: "d1"
  capabilities:
    - mcp_host
    - webhooks
mcp_servers:
  - name: "filesystem"
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem"]
    env:
      HOME: "/home/user"
webhooks:
  enabled: true
  port: 9090
  endpoints:
    - source: "github"
      path: "/hooks/github"
      secret: "gh-secret"
      conversation_id: "conv-1"
      participant_id: "part-1"
`);

    const config = loadConfig(configPath);

    expect(config.delegate.capabilities).toEqual(['mcp_host', 'webhooks']);
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers[0].name).toBe('filesystem');
    expect(config.mcp_servers[0].command).toBe('npx');
    expect(config.mcp_servers[0].args).toEqual(['-y', '@modelcontextprotocol/server-filesystem']);
    expect(config.mcp_servers[0].env).toEqual({ HOME: '/home/user' });
    expect(config.webhooks.enabled).toBe(true);
    expect(config.webhooks.port).toBe(9090);
    expect(config.webhooks.endpoints).toHaveLength(1);
    expect(config.webhooks.endpoints[0].source).toBe('github');
    expect(config.webhooks.endpoints[0].secret).toBe('gh-secret');
  });

  it('applies default args (empty array) to mcp_servers entries', () => {
    const configPath = writeYaml('mcp-no-args.yaml', `
server:
  url: "wss://example.com"
  token: "t"
delegate:
  id: "d"
mcp_servers:
  - name: "tool-server"
    command: "tool-server-bin"
`);

    const config = loadConfig(configPath);
    expect(config.mcp_servers[0].args).toEqual([]);
  });

  // ── 2. Missing file ──

  it('throws "Config file not found" when the file does not exist', () => {
    const missingPath = path.join(tmpDir, 'nonexistent.yaml');
    expect(() => loadConfig(missingPath)).toThrow('Config file not found');
  });

  // ── 3. Invalid YAML syntax ──

  it('throws when the file contains invalid YAML', () => {
    const configPath = writeYaml('bad.yaml', `
server:
  url: "wss://example.com"
  token: "tok"
  - this is not valid YAML: [[[
`);

    expect(() => loadConfig(configPath)).toThrow();
  });

  // ── 4. Valid YAML but missing required fields ──

  it('throws "Invalid config" with path info when server.url is missing', () => {
    const configPath = writeYaml('no-url.yaml', `
server:
  token: "tok"
delegate:
  id: "d1"
`);

    expect(() => loadConfig(configPath)).toThrow('Invalid config');
    expect(() => loadConfig(configPath)).toThrow(/server\.url/);
  });

  it('throws "Invalid config" when server.token is missing', () => {
    const configPath = writeYaml('no-token.yaml', `
server:
  url: "wss://example.com"
delegate:
  id: "d1"
`);

    expect(() => loadConfig(configPath)).toThrow('Invalid config');
    expect(() => loadConfig(configPath)).toThrow(/server\.token/);
  });

  it('throws "Invalid config" when delegate.id is missing', () => {
    const configPath = writeYaml('no-id.yaml', `
server:
  url: "wss://example.com"
  token: "tok"
delegate:
  capabilities:
    - mcp_host
`);

    expect(() => loadConfig(configPath)).toThrow('Invalid config');
    expect(() => loadConfig(configPath)).toThrow(/delegate\.id/);
  });

  it('throws "Invalid config" when server section is entirely missing', () => {
    const configPath = writeYaml('no-server.yaml', `
delegate:
  id: "d1"
`);

    expect(() => loadConfig(configPath)).toThrow('Invalid config');
  });

  it('throws "Invalid config" when delegate section is entirely missing', () => {
    const configPath = writeYaml('no-delegate.yaml', `
server:
  url: "wss://example.com"
  token: "tok"
`);

    expect(() => loadConfig(configPath)).toThrow('Invalid config');
  });

  // ── 5. Env var substitution ──

  it('resolves ${VAR} from process.env in string values', () => {
    const originalEnv = process.env.TEST_SERVER_URL;
    const originalToken = process.env.TEST_TOKEN;

    process.env.TEST_SERVER_URL = 'wss://resolved.example.com/ws';
    process.env.TEST_TOKEN = 'resolved-token-value';

    try {
      const configPath = writeYaml('env.yaml', `
server:
  url: "\${TEST_SERVER_URL}"
  token: "\${TEST_TOKEN}"
delegate:
  id: "d1"
`);

      const config = loadConfig(configPath);
      expect(config.server.url).toBe('wss://resolved.example.com/ws');
      expect(config.server.token).toBe('resolved-token-value');
    } finally {
      if (originalEnv === undefined) delete process.env.TEST_SERVER_URL;
      else process.env.TEST_SERVER_URL = originalEnv;

      if (originalToken === undefined) delete process.env.TEST_TOKEN;
      else process.env.TEST_TOKEN = originalToken;
    }
  });

  // ── 6. Undefined env var resolves to empty string ──

  it('resolves undefined env vars to empty string', () => {
    const varName = 'VERY_UNLIKELY_ENV_VAR_FOR_TEST_XYZ_12345';
    delete process.env[varName];

    const configPath = writeYaml('env-undefined.yaml', `
server:
  url: "wss://example.com"
  token: "prefix-\${${varName}}-suffix"
delegate:
  id: "d1"
`);

    const config = loadConfig(configPath);
    expect(config.server.token).toBe('prefix--suffix');
  });

  // ── 7. Env vars in nested objects and arrays ──

  it('resolves env vars inside nested objects', () => {
    const originalEnv = process.env.TEST_MCP_HOME;
    process.env.TEST_MCP_HOME = '/resolved/home';

    try {
      const configPath = writeYaml('env-nested.yaml', `
server:
  url: "wss://example.com"
  token: "tok"
delegate:
  id: "d1"
mcp_servers:
  - name: "filesystem"
    command: "npx"
    env:
      HOME: "\${TEST_MCP_HOME}"
`);

      const config = loadConfig(configPath);
      expect(config.mcp_servers[0].env!.HOME).toBe('/resolved/home');
    } finally {
      if (originalEnv === undefined) delete process.env.TEST_MCP_HOME;
      else process.env.TEST_MCP_HOME = originalEnv;
    }
  });

  it('resolves env vars inside arrays', () => {
    const originalEnv = process.env.TEST_ARG_VALUE;
    process.env.TEST_ARG_VALUE = 'resolved-arg';

    try {
      const configPath = writeYaml('env-array.yaml', `
server:
  url: "wss://example.com"
  token: "tok"
delegate:
  id: "d1"
mcp_servers:
  - name: "tool"
    command: "cmd"
    args:
      - "--flag"
      - "\${TEST_ARG_VALUE}"
`);

      const config = loadConfig(configPath);
      expect(config.mcp_servers[0].args).toEqual(['--flag', 'resolved-arg']);
    } finally {
      if (originalEnv === undefined) delete process.env.TEST_ARG_VALUE;
      else process.env.TEST_ARG_VALUE = originalEnv;
    }
  });

  it('resolves env vars inside deeply nested webhook config', () => {
    const originalEnv = process.env.TEST_WH_SECRET;
    process.env.TEST_WH_SECRET = 'deep-secret-value';

    try {
      const configPath = writeYaml('env-deep.yaml', `
server:
  url: "wss://example.com"
  token: "tok"
delegate:
  id: "d1"
webhooks:
  enabled: true
  port: 8080
  endpoints:
    - source: "github"
      path: "/hooks/gh"
      secret: "\${TEST_WH_SECRET}"
`);

      const config = loadConfig(configPath);
      expect(config.webhooks.endpoints[0].secret).toBe('deep-secret-value');
    } finally {
      if (originalEnv === undefined) delete process.env.TEST_WH_SECRET;
      else process.env.TEST_WH_SECRET = originalEnv;
    }
  });

  // ── 8. Non-string values pass through unchanged ──

  it('passes through numbers and booleans without modification', () => {
    const configPath = writeYaml('non-string.yaml', `
server:
  url: "wss://example.com"
  token: "tok"
delegate:
  id: "d1"
webhooks:
  enabled: true
  port: 3000
  endpoints: []
`);

    const config = loadConfig(configPath);
    expect(config.webhooks.enabled).toBe(true);
    expect(config.webhooks.port).toBe(3000);
    expect(typeof config.webhooks.enabled).toBe('boolean');
    expect(typeof config.webhooks.port).toBe('number');
  });

  it('handles a mix of env vars and literal values', () => {
    const originalEnv = process.env.TEST_MIXED_URL;
    process.env.TEST_MIXED_URL = 'wss://mixed.example.com';

    try {
      const configPath = writeYaml('mixed.yaml', `
server:
  url: "\${TEST_MIXED_URL}"
  token: "literal-token"
delegate:
  id: "literal-id"
webhooks:
  enabled: false
  port: 4000
  endpoints: []
`);

      const config = loadConfig(configPath);
      expect(config.server.url).toBe('wss://mixed.example.com');
      expect(config.server.token).toBe('literal-token');
      expect(config.webhooks.enabled).toBe(false);
      expect(config.webhooks.port).toBe(4000);
    } finally {
      if (originalEnv === undefined) delete process.env.TEST_MIXED_URL;
      else process.env.TEST_MIXED_URL = originalEnv;
    }
  });

  it('handles multiple env var references in a single string', () => {
    const originalA = process.env.TEST_HOST;
    const originalB = process.env.TEST_PORT_STR;
    process.env.TEST_HOST = 'example.com';
    process.env.TEST_PORT_STR = '443';

    try {
      const configPath = writeYaml('multi-env.yaml', `
server:
  url: "wss://\${TEST_HOST}:\${TEST_PORT_STR}/ws"
  token: "tok"
delegate:
  id: "d1"
`);

      const config = loadConfig(configPath);
      expect(config.server.url).toBe('wss://example.com:443/ws');
    } finally {
      if (originalA === undefined) delete process.env.TEST_HOST;
      else process.env.TEST_HOST = originalA;

      if (originalB === undefined) delete process.env.TEST_PORT_STR;
      else process.env.TEST_PORT_STR = originalB;
    }
  });

  it('does not substitute patterns that are not ${VAR} syntax', () => {
    const configPath = writeYaml('no-sub.yaml', `
server:
  url: "wss://example.com"
  token: "$HOME"
delegate:
  id: "d1"
`);

    const config = loadConfig(configPath);
    expect(config.server.token).toBe('$HOME');
  });

  it('handles empty YAML file gracefully (throws Invalid config)', () => {
    const configPath = writeYaml('empty.yaml', '');

    expect(() => loadConfig(configPath)).toThrow('Invalid config');
  });
});

// ─── findConfigPath ──────────────────────────────────────────────

describe('findConfigPath', () => {
  beforeEach(() => {
    // Default: no files exist
    fsMocks.existsSyncImpl = () => false;
  });

  afterEach(() => {
    fsMocks.existsSyncImpl = fsMocks.realExistsSync;
  });

  // ── 9. Explicit path returned directly ──

  it('returns the explicit path directly without checking existence', () => {
    const result = findConfigPath('/some/explicit/path.yaml');
    expect(result).toBe('/some/explicit/path.yaml');
  });

  it('returns the explicit path even if it does not exist on disk', () => {
    const fakePath = '/nonexistent/dir/config.yaml';
    const result = findConfigPath(fakePath);
    expect(result).toBe(fakePath);
  });

  it('returns the explicit path without modification for relative paths', () => {
    const result = findConfigPath('./my-custom-config.yml');
    expect(result).toBe('./my-custom-config.yml');
  });

  // ── 10. No explicit path and no files found ──

  it('throws "No config file found" when no candidate files exist', () => {
    fsMocks.existsSyncImpl = () => false;

    expect(() => findConfigPath()).toThrow('No config file found');
    expect(() => findConfigPath(undefined)).toThrow(
      'Create delegate.yaml or specify with --config'
    );
  });

  it('includes example config reference in error message', () => {
    fsMocks.existsSyncImpl = () => false;

    expect(() => findConfigPath()).toThrow('delegate.example.yaml');
  });

  // ── 11. Finds first matching candidate ──

  it('returns ./delegate.yaml when it exists', () => {
    fsMocks.existsSyncImpl = ((p: unknown) => {
      const s = String(p);
      return s.endsWith('delegate.yaml') && !s.includes('config');
    }) as typeof fsMocks.existsSyncImpl;

    const result = findConfigPath();
    expect(result).toBe('./delegate.yaml');
  });

  it('returns ./delegate.yml when ./delegate.yaml does not exist', () => {
    fsMocks.existsSyncImpl = ((p: unknown) => {
      const s = String(p);
      return s.endsWith('delegate.yml') && !s.includes('config');
    }) as typeof fsMocks.existsSyncImpl;

    const result = findConfigPath();
    expect(result).toBe('./delegate.yml');
  });

  it('returns ./config/delegate.yaml when ./delegate.yaml and ./delegate.yml do not exist', () => {
    fsMocks.existsSyncImpl = ((p: unknown) => {
      const s = String(p);
      return s.includes('config') && s.endsWith('delegate.yaml');
    }) as typeof fsMocks.existsSyncImpl;

    const result = findConfigPath();
    expect(result).toBe('./config/delegate.yaml');
  });

  it('returns ./config/delegate.yml as the last candidate', () => {
    fsMocks.existsSyncImpl = ((p: unknown) => {
      const s = String(p);
      return s.includes('config') && s.endsWith('delegate.yml');
    }) as typeof fsMocks.existsSyncImpl;

    const result = findConfigPath();
    expect(result).toBe('./config/delegate.yml');
  });

  it('returns the first match when multiple candidates exist', () => {
    fsMocks.existsSyncImpl = () => true;

    const result = findConfigPath();
    expect(result).toBe('./delegate.yaml');
  });

  it('does not call existsSync when explicit path is provided', () => {
    let existsCalled = false;
    fsMocks.existsSyncImpl = (() => {
      existsCalled = true;
      return false;
    }) as typeof fsMocks.existsSyncImpl;

    findConfigPath('/explicit/path.yaml');
    expect(existsCalled).toBe(false);
  });
});
