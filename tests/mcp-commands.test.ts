import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'path';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/prompts.js', () => ({
  promptText: vi.fn(),
  promptSelect: vi.fn(),
  promptConfirm: vi.fn(),
}));

vi.mock('../src/config-utils.js', () => ({
  readConfigRaw: vi.fn(),
  updateConfig: vi.fn(),
}));

import { promptText, promptSelect, promptConfirm } from '../src/prompts.js';
import { readConfigRaw, updateConfig } from '../src/config-utils.js';
import { interactiveMcpAdd, listMcpServers, removeMcpServer } from '../src/mcp-commands.js';

const mockPromptText = vi.mocked(promptText);
const mockPromptSelect = vi.mocked(promptSelect);
const mockPromptConfirm = vi.mocked(promptConfirm);
const mockReadConfigRaw = vi.mocked(readConfigRaw);
const mockUpdateConfig = vi.mocked(updateConfig);

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

// =============================================================================
// interactiveMcpAdd
// =============================================================================

describe('interactiveMcpAdd', () => {
  // ─── Template: memory (no prompts) ──────────────────────────────

  it('adds "memory" template with correct name/command/args and returns true', async () => {
    // memory is index 1 in template order: filesystem(0), memory(1), sequential-thinking(2)
    mockPromptSelect.mockResolvedValue(1);
    // readConfigRaw returns empty config (no duplicates)
    mockReadConfigRaw.mockReturnValue({
      path: '/path/to/delegate.yaml',
      data: { mcp_servers: [] },
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);
    expect(mockPromptSelect).toHaveBeenCalledOnce();
    // No promptText calls — memory template has no prompts
    expect(mockPromptText).not.toHaveBeenCalled();

    // Verify updateConfig was called and the callback adds the correct entry
    expect(mockUpdateConfig).toHaveBeenCalledWith(undefined, expect.any(Function));
    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = { mcp_servers: [] };
    callback(config);
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers[0]).toEqual({
      name: 'memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    });

    expect(logSpy).toHaveBeenCalledWith('Added MCP server "memory".');
  });

  // ─── Cancel on template selection ─────────────────────────────

  it('returns false when promptSelect returns null (cancelled)', async () => {
    mockPromptSelect.mockResolvedValue(null);

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Template: filesystem with paths ──────────────────────────

  it('adds "filesystem" template with resolved paths', async () => {
    mockPromptSelect.mockResolvedValue(0); // filesystem is index 0
    mockPromptText.mockResolvedValue('/home/user/docs, /tmp/data');
    mockReadConfigRaw.mockReturnValue({
      path: '/path/to/delegate.yaml',
      data: { mcp_servers: [] },
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);
    expect(mockPromptText).toHaveBeenCalledWith('Paths to expose (comma-separated)');

    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = { mcp_servers: [] };
    callback(config);
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers[0].name).toBe('filesystem');
    expect(config.mcp_servers[0].command).toBe('npx');
    // Args should include baseArgs + resolved paths
    expect(config.mcp_servers[0].args[0]).toBe('-y');
    expect(config.mcp_servers[0].args[1]).toBe('@modelcontextprotocol/server-filesystem');
    expect(config.mcp_servers[0].args[2]).toBe(resolve('/home/user/docs'));
    expect(config.mcp_servers[0].args[3]).toBe(resolve('/tmp/data'));
  });

  // ─── Cancel on filesystem path prompt ─────────────────────────

  it('returns false when path prompt is cancelled (filesystem template)', async () => {
    mockPromptSelect.mockResolvedValue(0); // filesystem
    mockPromptText.mockResolvedValue(null);

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Empty required answer ────────────────────────────────────

  it('returns false and logs error when required answer is empty (filesystem template)', async () => {
    mockPromptSelect.mockResolvedValue(0); // filesystem
    mockPromptText.mockResolvedValue(''); // empty string, but required

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith('paths is required.');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Custom server (basic) ────────────────────────────────────

  it('adds custom server with name/command/args and returns true', async () => {
    // choice = 3 means custom (templateNames.length === 3)
    mockPromptSelect.mockResolvedValue(3);
    mockPromptText
      .mockResolvedValueOnce('my-server')      // Server name
      .mockResolvedValueOnce('node')            // Command
      .mockResolvedValueOnce('--port 8080')     // Arguments
      .mockResolvedValueOnce('');               // Env var name (empty = skip)

    mockReadConfigRaw.mockReturnValue({
      path: '/path/to/delegate.yaml',
      data: { mcp_servers: [] },
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);

    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = { mcp_servers: [] };
    callback(config);
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers[0]).toEqual({
      name: 'my-server',
      command: 'node',
      args: ['--port', '8080'],
    });
    // No env since we skipped it
    expect(config.mcp_servers[0].env).toBeUndefined();

    expect(logSpy).toHaveBeenCalledWith('Added MCP server "my-server".');
  });

  // ─── Custom server with env vars ──────────────────────────────

  it('adds custom server with env vars when provided', async () => {
    mockPromptSelect.mockResolvedValue(3); // custom
    mockPromptText
      .mockResolvedValueOnce('api-server')    // Server name
      .mockResolvedValueOnce('npx')           // Command
      .mockResolvedValueOnce('-y my-pkg')     // Arguments
      .mockResolvedValueOnce('API_KEY')       // Env var name
      .mockResolvedValueOnce('secret123')     // Env var value
      .mockResolvedValueOnce('DB_URL')        // Another env var name
      .mockResolvedValueOnce('postgres://x')  // Another env var value
      .mockResolvedValueOnce('');             // Empty = stop asking for env vars

    mockReadConfigRaw.mockReturnValue({
      path: '/path/to/delegate.yaml',
      data: { mcp_servers: [] },
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);

    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = { mcp_servers: [] };
    callback(config);
    expect(config.mcp_servers[0]).toEqual({
      name: 'api-server',
      command: 'npx',
      args: ['-y', 'my-pkg'],
      env: { API_KEY: 'secret123', DB_URL: 'postgres://x' },
    });
  });

  // ─── Custom server cancel on name ─────────────────────────────

  it('returns false when custom server name is cancelled (null)', async () => {
    mockPromptSelect.mockResolvedValue(3); // custom
    mockPromptText.mockResolvedValueOnce(null); // cancel on name

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('returns false when custom server name is empty string', async () => {
    mockPromptSelect.mockResolvedValue(3); // custom
    mockPromptText.mockResolvedValueOnce(''); // empty name

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Custom server cancel on command ──────────────────────────

  it('returns false when custom server command is cancelled', async () => {
    mockPromptSelect.mockResolvedValue(3);
    mockPromptText
      .mockResolvedValueOnce('my-server')  // name
      .mockResolvedValueOnce(null);        // cancel on command

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Custom server cancel on arguments ────────────────────────

  it('returns false when custom server arguments prompt is cancelled', async () => {
    mockPromptSelect.mockResolvedValue(3);
    mockPromptText
      .mockResolvedValueOnce('my-server')
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce(null);  // cancel on args

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Custom server cancel on env var name ─────────────────────

  it('returns false when env var name prompt is cancelled', async () => {
    mockPromptSelect.mockResolvedValue(3);
    mockPromptText
      .mockResolvedValueOnce('my-server')
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('--port 3000')
      .mockResolvedValueOnce(null);  // cancel on env var name

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Custom server cancel on env var value ────────────────────

  it('returns false when env var value prompt is cancelled', async () => {
    mockPromptSelect.mockResolvedValue(3);
    mockPromptText
      .mockResolvedValueOnce('my-server')
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('--port 3000')
      .mockResolvedValueOnce('MY_VAR')   // env var name
      .mockResolvedValueOnce(null);      // cancel on env var value

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Custom server with empty args ────────────────────────────

  it('adds custom server with empty args array when no arguments provided', async () => {
    mockPromptSelect.mockResolvedValue(3);
    mockPromptText
      .mockResolvedValueOnce('bare-server')
      .mockResolvedValueOnce('my-cmd')
      .mockResolvedValueOnce('')   // empty args
      .mockResolvedValueOnce('');  // no env vars

    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: { mcp_servers: [] },
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);
    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = { mcp_servers: [] };
    callback(config);
    expect(config.mcp_servers[0].args).toEqual([]);
  });

  // ─── Duplicate name ───────────────────────────────────────────

  it('returns false and logs error when server name already exists', async () => {
    mockPromptSelect.mockResolvedValue(1); // memory
    // BUG-11: duplicate check now runs inside updateConfig callback (under lock).
    // Mock updateConfig to execute the callback with a config that already has "memory".
    mockUpdateConfig.mockImplementation((_path: any, cb: any) => {
      const config = {
        mcp_servers: [
          { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        ],
      };
      cb(config);
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('MCP server "memory" already exists'),
    );
  });

  // ─── Config doesn't exist yet (catch branch) ─────────────────

  it('still adds server when readConfigRaw throws (config does not exist yet)', async () => {
    mockPromptSelect.mockResolvedValue(1); // memory
    mockReadConfigRaw.mockImplementation(() => {
      throw new Error('No config file found');
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);
    // updateConfig should still be called despite the readConfigRaw error
    expect(mockUpdateConfig).toHaveBeenCalledOnce();

    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = {};
    callback(config);
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers[0].name).toBe('memory');
  });

  // ─── Config has no mcp_servers key ────────────────────────────

  it('initializes mcp_servers array when config lacks the key', async () => {
    mockPromptSelect.mockResolvedValue(1); // memory
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {}, // no mcp_servers key
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);

    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = {};
    callback(config);
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers[0].name).toBe('memory');
  });

  // ─── sequential-thinking template ─────────────────────────────

  it('adds "sequential-thinking" template (index 2) correctly', async () => {
    mockPromptSelect.mockResolvedValue(2);
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: { mcp_servers: [] },
    });

    const result = await interactiveMcpAdd();

    expect(result).toBe(true);
    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = { mcp_servers: [] };
    callback(config);
    expect(config.mcp_servers[0]).toEqual({
      name: 'sequential-thinking',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    });
  });

  // ─── Passes configPathOverride ────────────────────────────────

  it('passes configPathOverride to updateConfig', async () => {
    mockPromptSelect.mockResolvedValue(1); // memory

    await interactiveMcpAdd('/custom/path.yaml');

    // BUG-11: readConfigRaw is no longer called — duplicate check moved inside updateConfig.
    expect(mockReadConfigRaw).not.toHaveBeenCalled();
    expect(mockUpdateConfig).toHaveBeenCalledWith('/custom/path.yaml', expect.any(Function));
  });

  // ─── promptSelect shows correct options ───────────────────────

  it('shows template options plus custom in promptSelect', async () => {
    mockPromptSelect.mockResolvedValue(null);

    await interactiveMcpAdd();

    expect(mockPromptSelect).toHaveBeenCalledWith('Add MCP server:', [
      'filesystem \u2014 File read/write access',
      'memory \u2014 Persistent memory / knowledge graph',
      'sequential-thinking \u2014 Step-by-step reasoning aid',
      'custom \u2014 provide your own command',
    ]);
  });
});

// =============================================================================
// listMcpServers
// =============================================================================

describe('listMcpServers', () => {
  // ─── With servers ─────────────────────────────────────────────

  it('logs server list when servers are configured', () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/path/to/delegate.yaml',
      data: {
        mcp_servers: [
          { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
          { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] },
        ],
      },
    });

    listMcpServers();

    expect(logSpy).toHaveBeenCalledWith('MCP servers (2):\n');
    expect(logSpy).toHaveBeenCalledWith(
      '  1. memory \u2014 npx -y @modelcontextprotocol/server-memory',
    );
    expect(logSpy).toHaveBeenCalledWith(
      '  2. filesystem \u2014 npx -y @modelcontextprotocol/server-filesystem /tmp',
    );
    expect(logSpy).toHaveBeenCalledWith('\nConfig: /path/to/delegate.yaml');
  });

  // ─── Empty list ───────────────────────────────────────────────

  it('logs "No MCP servers configured" when list is empty', () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/path/to/delegate.yaml',
      data: { mcp_servers: [] },
    });

    listMcpServers();

    expect(logSpy).toHaveBeenCalledWith('No MCP servers configured.');
    expect(logSpy).toHaveBeenCalledWith('Config: /path/to/delegate.yaml');
  });

  // ─── No mcp_servers key at all ────────────────────────────────

  it('logs "No MCP servers configured" when mcp_servers is missing', () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {},
    });

    listMcpServers();

    expect(logSpy).toHaveBeenCalledWith('No MCP servers configured.');
  });

  // ─── With env vars ────────────────────────────────────────────

  it('shows env key names for servers that have env vars', () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {
        mcp_servers: [
          {
            name: 'api-server',
            command: 'node',
            args: ['server.js'],
            env: { API_KEY: 'secret', DB_URL: 'postgres://x' },
          },
        ],
      },
    });

    listMcpServers();

    expect(logSpy).toHaveBeenCalledWith('  1. api-server \u2014 node server.js');
    expect(logSpy).toHaveBeenCalledWith('     env: API_KEY, DB_URL');
  });

  // ─── Server without args ──────────────────────────────────────

  it('handles servers with no args array gracefully', () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {
        mcp_servers: [{ name: 'bare', command: 'test-cmd' }],
      },
    });

    listMcpServers();

    expect(logSpy).toHaveBeenCalledWith('  1. bare \u2014 test-cmd ');
  });

  // ─── Passes configPathOverride ────────────────────────────────

  it('passes configPathOverride to readConfigRaw', () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/custom/path.yaml',
      data: { mcp_servers: [] },
    });

    listMcpServers('/custom/path.yaml');

    expect(mockReadConfigRaw).toHaveBeenCalledWith('/custom/path.yaml');
  });
});

// =============================================================================
// removeMcpServer
// =============================================================================

describe('removeMcpServer', () => {
  // ─── Existing server with confirmation ────────────────────────

  it('removes existing server when confirmed and returns true', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {
        mcp_servers: [
          { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
          { name: 'filesystem', command: 'npx', args: ['-y', 'pkg', '/tmp'] },
        ],
      },
    });
    mockPromptConfirm.mockResolvedValue(true);

    const result = await removeMcpServer('memory');

    expect(result).toBe(true);
    expect(mockPromptConfirm).toHaveBeenCalledWith(
      'Remove "memory" (npx -y @modelcontextprotocol/server-memory)?',
    );

    // Verify updateConfig callback removes the correct server
    expect(mockUpdateConfig).toHaveBeenCalledWith(undefined, expect.any(Function));
    const callback = mockUpdateConfig.mock.calls[0][1];
    const config: any = {
      mcp_servers: [
        { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        { name: 'filesystem', command: 'npx', args: ['-y', 'pkg', '/tmp'] },
      ],
    };
    callback(config);
    expect(config.mcp_servers).toHaveLength(1);
    expect(config.mcp_servers[0].name).toBe('filesystem');

    expect(logSpy).toHaveBeenCalledWith('Removed MCP server "memory".');
  });

  // ─── Nonexistent server ───────────────────────────────────────

  it('returns false and logs error when server name is not found', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: { mcp_servers: [{ name: 'other', command: 'npx', args: [] }] },
    });

    const result = await removeMcpServer('nonexistent');

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith('MCP server "nonexistent" not found.');
    expect(mockPromptConfirm).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── Empty mcp_servers list ───────────────────────────────────

  it('returns false when mcp_servers is empty', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: { mcp_servers: [] },
    });

    const result = await removeMcpServer('memory');

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith('MCP server "memory" not found.');
  });

  // ─── No mcp_servers key ───────────────────────────────────────

  it('returns false when config has no mcp_servers key', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {},
    });

    const result = await removeMcpServer('memory');

    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith('MCP server "memory" not found.');
  });

  // ─── Cancelled confirmation ───────────────────────────────────

  it('returns false and logs "Cancelled" when confirmation is denied', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {
        mcp_servers: [
          { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        ],
      },
    });
    mockPromptConfirm.mockResolvedValue(false);

    const result = await removeMcpServer('memory');

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledWith('Cancelled.');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it('returns false when confirmation returns null (Ctrl+C)', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {
        mcp_servers: [
          { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        ],
      },
    });
    mockPromptConfirm.mockResolvedValue(null);

    const result = await removeMcpServer('memory');

    expect(result).toBe(false);
    expect(logSpy).toHaveBeenCalledWith('Cancelled.');
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  // ─── skipConfirm = true ───────────────────────────────────────

  it('skips confirmation prompt and removes directly when skipConfirm is true', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {
        mcp_servers: [
          { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
        ],
      },
    });

    const result = await removeMcpServer('memory', undefined, true);

    expect(result).toBe(true);
    expect(mockPromptConfirm).not.toHaveBeenCalled();
    expect(mockUpdateConfig).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith('Removed MCP server "memory".');
  });

  // ─── Passes configPathOverride ────────────────────────────────

  it('passes configPathOverride to readConfigRaw and updateConfig', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/custom/cfg.yaml',
      data: {
        mcp_servers: [{ name: 'test', command: 'cmd', args: [] }],
      },
    });
    mockPromptConfirm.mockResolvedValue(true);

    await removeMcpServer('test', '/custom/cfg.yaml');

    expect(mockReadConfigRaw).toHaveBeenCalledWith('/custom/cfg.yaml');
    expect(mockUpdateConfig).toHaveBeenCalledWith('/custom/cfg.yaml', expect.any(Function));
  });

  // ─── Server without args in description ───────────────────────

  it('handles server with no args in confirmation description', async () => {
    mockReadConfigRaw.mockReturnValue({
      path: '/cfg.yaml',
      data: {
        mcp_servers: [{ name: 'bare', command: 'my-cmd' }],
      },
    });
    mockPromptConfirm.mockResolvedValue(true);

    const result = await removeMcpServer('bare');

    expect(result).toBe(true);
    expect(mockPromptConfirm).toHaveBeenCalledWith('Remove "bare" (my-cmd )?');
  });
});
