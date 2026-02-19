import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the MCP SDK modules BEFORE importing the module under test.
// We mock Client (from @modelcontextprotocol/sdk/client/index.js),
// StdioClientTransport, and SSEClientTransport so that startAll / addServer
// can run without real subprocesses.
//
// The mocks must be classes (not arrow functions) so they work with `new`.
// ---------------------------------------------------------------------------

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockCallTool = vi.fn().mockResolvedValue({ content: [], isError: false });

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  return {
    Client: class MockClient {
      connect = mockConnect;
      close = mockClose;
      listTools = mockListTools;
      callTool = mockCallTool;
      constructor(_info: unknown, _opts: unknown) {}
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  return {
    StdioClientTransport: class MockStdioTransport {
      constructor(_opts: unknown) {}
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  return {
    SSEClientTransport: class MockSSETransport {
      constructor(_url: unknown) {}
    },
  };
});

import { McpHostManager } from '../src/mcp-host.js';
import type { McpServerConfig, ToolDefinition } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(name: string, command = 'node', args: string[] = ['server.js']): McpServerConfig {
  return { name, command, args };
}

function makeToolDef(name: string, desc = ''): { name: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    name,
    description: desc,
    inputSchema: { type: 'object', properties: {} },
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('McpHostManager', () => {
  let manager: McpHostManager;

  beforeEach(() => {
    manager = new McpHostManager();
    vi.clearAllMocks();

    // Default: listTools returns empty
    mockListTools.mockResolvedValue({ tools: [] });
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({ content: [], isError: false });
  });

  // =========================================================================
  // startAll + rebuildToolList
  // =========================================================================

  describe('startAll + rebuildToolList', () => {
    it('logs "No MCP servers configured" and returns early for empty configs', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([]);
      expect(logSpy).toHaveBeenCalledWith('[McpHost] No MCP servers configured');
      expect(manager.getAllTools()).toEqual([]);
      expect(manager.getToolServerMap().size).toBe(0);
      logSpy.mockRestore();
    });

    it('starts 1 server and collects its tools', async () => {
      mockListTools.mockResolvedValue({
        tools: [makeToolDef('read_file', 'Read a file'), makeToolDef('write_file', 'Write a file')],
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('filesystem')]);

      const allTools = manager.getAllTools();
      expect(allTools).toHaveLength(2);
      expect(allTools.map(t => t.name)).toContain('read_file');
      expect(allTools.map(t => t.name)).toContain('write_file');

      const toolMap = manager.getToolServerMap();
      expect(toolMap.get('read_file')).toBe('filesystem');
      expect(toolMap.get('write_file')).toBe('filesystem');

      logSpy.mockRestore();
    });

    it('starts multiple servers and populates tools from each', async () => {
      // Each call to listTools returns tools for the respective server.
      // Since the mock Client constructor is called per-server, they all share mockListTools.
      // We use mockResolvedValueOnce to sequence per-server results.
      mockListTools
        .mockResolvedValueOnce({ tools: [makeToolDef('tool_a')] })
        .mockResolvedValueOnce({ tools: [makeToolDef('tool_b')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('alpha'), makeConfig('beta')]);

      const toolMap = manager.getToolServerMap();
      expect(toolMap.size).toBe(2);
      expect(toolMap.get('tool_a')).toBe('alpha');
      expect(toolMap.get('tool_b')).toBe('beta');

      logSpy.mockRestore();
    });

    it('handles server spawn failure gracefully (Promise.allSettled resilience)', async () => {
      // First server connect succeeds, second fails
      mockConnect
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('spawn ENOENT'));

      mockListTools.mockResolvedValue({ tools: [makeToolDef('ok_tool')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await manager.startAll([makeConfig('good-server'), makeConfig('bad-server')]);

      // The good server should still have its tools available
      const toolMap = manager.getToolServerMap();
      expect(toolMap.has('ok_tool')).toBe(true);

      // Error should be logged for the failed server
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to start "bad-server"'),
        expect.anything()
      );

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('detects duplicate tools across servers and first-alphabetically wins', async () => {
      // Both servers provide a tool named "shared_tool".
      // Server "alpha" is alphabetically before "beta", so alpha wins.
      mockListTools
        .mockResolvedValueOnce({ tools: [makeToolDef('shared_tool', 'from beta')] })
        .mockResolvedValueOnce({ tools: [makeToolDef('shared_tool', 'from alpha')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Note: configs are given in non-alphabetical order to verify sorting
      await manager.startAll([makeConfig('beta'), makeConfig('alpha')]);

      const toolMap = manager.getToolServerMap();
      // "alpha" should win because rebuildToolList sorts servers alphabetically
      expect(toolMap.get('shared_tool')).toBe('alpha');

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('getDuplicateWarnings returns correct warnings with toolName, fromServer, conflictsWith', async () => {
      mockListTools
        .mockResolvedValueOnce({ tools: [makeToolDef('dup_tool')] })
        .mockResolvedValueOnce({ tools: [makeToolDef('dup_tool')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.startAll([makeConfig('alpha'), makeConfig('beta')]);

      const warnings = manager.getDuplicateWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual({
        toolName: 'dup_tool',
        fromServer: 'beta',       // beta is the duplicate (alpha wins alphabetically)
        conflictsWith: 'alpha',   // alpha is the first-wins server
      });

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // callTool
  // =========================================================================

  describe('callTool', () => {
    it('returns error for unknown tool', async () => {
      const result = await manager.callTool('nonexistent', {});
      expect(result).toEqual({ content: 'Unknown tool: nonexistent', isError: true });
    });

    it('delegates to the correct server client for a known tool', async () => {
      mockListTools.mockResolvedValue({
        tools: [makeToolDef('my_tool')],
      });
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'hello from tool' }],
        isError: false,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('server-a')]);

      const result = await manager.callTool('my_tool', { arg1: 'value1' });
      expect(result.content).toBe('hello from tool');
      expect(result.isError).toBe(false);
      expect(mockCallTool).toHaveBeenCalledWith({ name: 'my_tool', arguments: { arg1: 'value1' } });

      logSpy.mockRestore();
    });

    it('extracts text from multiple text content blocks joined by newlines', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('multi_text')] });
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
          { type: 'text', text: 'line 3' },
        ],
        isError: false,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('text-server')]);

      const result = await manager.callTool('multi_text', {});
      expect(result.content).toBe('line 1\nline 2\nline 3');
      expect(result.isError).toBe(false);

      logSpy.mockRestore();
    });

    it('replaces image content block with "[image]"', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('image_tool')] });
      mockCallTool.mockResolvedValue({
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
        isError: false,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('img-server')]);

      const result = await manager.callTool('image_tool', {});
      expect(result.content).toBe('[image]');

      logSpy.mockRestore();
    });

    it('replaces resource content block with "[resource: uri]"', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('resource_tool')] });
      mockCallTool.mockResolvedValue({
        content: [{ type: 'resource', uri: 'file:///tmp/data.json' }],
        isError: false,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('res-server')]);

      const result = await manager.callTool('resource_tool', {});
      expect(result.content).toBe('[resource: file:///tmp/data.json]');

      logSpy.mockRestore();
    });

    it('returns "[resource: unknown]" when resource has no uri', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('resource_tool')] });
      mockCallTool.mockResolvedValue({
        content: [{ type: 'resource' }],
        isError: false,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('res-server')]);

      const result = await manager.callTool('resource_tool', {});
      expect(result.content).toBe('[resource: unknown]');

      logSpy.mockRestore();
    });

    it('returns "(empty result)" when content array is empty', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('empty_tool')] });
      mockCallTool.mockResolvedValue({
        content: [],
        isError: false,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('empty-server')]);

      const result = await manager.callTool('empty_tool', {});
      expect(result.content).toBe('(empty result)');
      expect(result.isError).toBe(false);

      logSpy.mockRestore();
    });

    it('returns tool execution error when server client throws', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('crash_tool')] });
      mockCallTool.mockRejectedValue(new Error('Connection lost'));

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await manager.startAll([makeConfig('crash-server')]);

      const result = await manager.callTool('crash_tool', {});
      expect(result.content).toBe('Tool execution error: Connection lost');
      expect(result.isError).toBe(true);

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('passes through isError=true from MCP result', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('error_tool')] });
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('err-server')]);

      const result = await manager.callTool('error_tool', {});
      expect(result.content).toBe('something went wrong');
      expect(result.isError).toBe(true);

      logSpy.mockRestore();
    });

    it('handles non-Error thrown values in callTool', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('throw_tool')] });
      mockCallTool.mockRejectedValue('string error thrown');

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await manager.startAll([makeConfig('throw-server')]);

      const result = await manager.callTool('throw_tool', {});
      expect(result.content).toBe('Tool execution error: string error thrown');
      expect(result.isError).toBe(true);

      logSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('handles mixed content block types in a single result', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('mixed_tool')] });
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'Result:' },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
          { type: 'resource', uri: 'file:///data.csv' },
          { type: 'text', text: 'Done.' },
        ],
        isError: false,
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('mixed-server')]);

      const result = await manager.callTool('mixed_tool', {});
      expect(result.content).toBe('Result:\n[image]\n[resource: file:///data.csv]\nDone.');
      expect(result.isError).toBe(false);

      logSpy.mockRestore();
    });
  });

  // =========================================================================
  // callTool with _scope_elevate
  // =========================================================================

  describe('callTool _scope_elevate', () => {
    it('calls the scope elevate handler and returns JSON result', async () => {
      const handler = vi.fn().mockResolvedValue({ approved: true, newCapabilities: ['write'] });
      manager.setScopeElevateHandler(handler);

      const result = await manager.callTool('_scope_elevate', {
        featureSet: 'editor',
        label: 'Enable editing',
        reason: 'User wants to edit files',
        capabilities: ['write'],
      });

      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual({ approved: true, newCapabilities: ['write'] });
      expect(handler).toHaveBeenCalledWith({
        featureSet: 'editor',
        label: 'Enable editing',
        reason: 'User wants to edit files',
        capabilities: ['write'],
      });
    });

    it('returns "Unknown tool" when _scope_elevate is called without handler', async () => {
      // No handler set on this manager
      const result = await manager.callTool('_scope_elevate', {
        featureSet: 'test',
        label: 'Test',
        reason: 'test',
        capabilities: [],
      });

      expect(result.content).toBe('Unknown tool: _scope_elevate');
      expect(result.isError).toBe(true);
    });

    it('returns isError=true when scope elevate handler throws an Error', async () => {
      const handler = vi.fn().mockRejectedValue(new Error('Elevation denied by policy'));
      manager.setScopeElevateHandler(handler);

      const result = await manager.callTool('_scope_elevate', { featureSet: 'admin', label: 'Admin', reason: 'need admin', capabilities: ['admin'] });

      expect(result.isError).toBe(true);
      expect(result.content).toBe('Scope elevate failed: Elevation denied by policy');
    });

    it('returns isError=true when scope elevate handler throws a non-Error value', async () => {
      const handler = vi.fn().mockRejectedValue('string rejection');
      manager.setScopeElevateHandler(handler);

      const result = await manager.callTool('_scope_elevate', { featureSet: 'x', label: 'x', reason: 'x', capabilities: [] });

      expect(result.isError).toBe(true);
      expect(result.content).toBe('Scope elevate failed: string rejection');
    });

    it('returns approved=false from handler', async () => {
      const handler = vi.fn().mockResolvedValue({ approved: false });
      manager.setScopeElevateHandler(handler);

      const result = await manager.callTool('_scope_elevate', { featureSet: 'x', label: 'x', reason: 'x', capabilities: [] });

      expect(result.isError).toBe(false);
      expect(JSON.parse(result.content)).toEqual({ approved: false });
    });
  });

  // =========================================================================
  // getAllToolsWithServer
  // =========================================================================

  describe('getAllToolsWithServer', () => {
    it('includes serverName on each tool', async () => {
      mockListTools.mockResolvedValue({
        tools: [makeToolDef('tool_x', 'Tool X'), makeToolDef('tool_y', 'Tool Y')],
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('my-server')]);

      const tools = manager.getAllToolsWithServer();
      expect(tools).toHaveLength(2);
      for (const tool of tools) {
        expect(tool.serverName).toBe('my-server');
      }

      logSpy.mockRestore();
    });

    it('includes _scope_elevate tool when handler is set', async () => {
      manager.setScopeElevateHandler(vi.fn().mockResolvedValue({ approved: true }));

      const tools = manager.getAllToolsWithServer();
      const elevate = tools.find(t => t.name === '_scope_elevate');
      expect(elevate).toBeDefined();
      expect(elevate!.description).toContain('capability elevation');
      expect(elevate!.inputSchema.required).toEqual(['featureSet', 'label', 'reason', 'capabilities']);
    });

    it('does NOT include _scope_elevate tool when no handler is set', async () => {
      // No handler set
      const tools = manager.getAllToolsWithServer();
      const elevate = tools.find(t => t.name === '_scope_elevate');
      expect(elevate).toBeUndefined();
    });

    it('excludes duplicate tools (only non-duplicate tools from toolToServer)', async () => {
      // Both servers have "shared_tool"; only one should appear in getAllToolsWithServer
      mockListTools
        .mockResolvedValueOnce({ tools: [makeToolDef('shared_tool'), makeToolDef('unique_a')] })
        .mockResolvedValueOnce({ tools: [makeToolDef('shared_tool'), makeToolDef('unique_b')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.startAll([makeConfig('alpha'), makeConfig('beta')]);

      const tools = manager.getAllToolsWithServer();
      const sharedTools = tools.filter(t => t.name === 'shared_tool');
      expect(sharedTools).toHaveLength(1);
      expect(sharedTools[0].serverName).toBe('alpha'); // alpha wins alphabetically

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // stopAll
  // =========================================================================

  describe('stopAll', () => {
    it('clears servers, toolToServer, and warnings', async () => {
      mockListTools
        .mockResolvedValueOnce({ tools: [makeToolDef('dup')] })
        .mockResolvedValueOnce({ tools: [makeToolDef('dup')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.startAll([makeConfig('srv-a'), makeConfig('srv-b')]);

      // Precondition: verify there are tools and warnings
      expect(manager.getToolServerMap().size).toBeGreaterThan(0);
      expect(manager.getDuplicateWarnings().length).toBeGreaterThan(0);
      expect(manager.getAllTools().length).toBeGreaterThan(0);

      await manager.stopAll();

      expect(manager.getToolServerMap().size).toBe(0);
      expect(manager.getDuplicateWarnings()).toEqual([]);
      expect(manager.getAllTools()).toEqual([]);

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('is a no-op when no servers are running', async () => {
      // Should not throw or log anything unexpected
      await manager.stopAll();
      expect(manager.getToolServerMap().size).toBe(0);
    });

    it('handles close errors gracefully', async () => {
      mockListTools.mockResolvedValue({ tools: [makeToolDef('tool1')] });
      mockClose.mockRejectedValue(new Error('close failed'));

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await manager.startAll([makeConfig('fragile-server')]);

      // Should not throw even though close() rejects
      await expect(manager.stopAll()).resolves.toBeUndefined();

      // Warn should be logged
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error stopping'),
        expect.anything()
      );

      logSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // getToolServerMap
  // =========================================================================

  describe('getToolServerMap', () => {
    it('returns a readonly map of tool name to server name', async () => {
      mockListTools.mockResolvedValue({
        tools: [makeToolDef('read_file'), makeToolDef('write_file')],
      });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await manager.startAll([makeConfig('filesystem')]);

      const map = manager.getToolServerMap();
      expect(map.get('read_file')).toBe('filesystem');
      expect(map.get('write_file')).toBe('filesystem');
      expect(map.size).toBe(2);

      logSpy.mockRestore();
    });

    it('returns empty map before any servers are started', () => {
      const map = manager.getToolServerMap();
      expect(map.size).toBe(0);
    });
  });

  // =========================================================================
  // getAllTools
  // =========================================================================

  describe('getAllTools', () => {
    it('returns all tools from all servers (including duplicate definitions)', async () => {
      // getAllTools returns raw tool lists from servers, not the deduplicated toolToServer map
      mockListTools
        .mockResolvedValueOnce({ tools: [makeToolDef('tool_a'), makeToolDef('shared')] })
        .mockResolvedValueOnce({ tools: [makeToolDef('tool_b'), makeToolDef('shared')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.startAll([makeConfig('srv-1'), makeConfig('srv-2')]);

      const allTools = manager.getAllTools();
      // getAllTools returns raw server tools, so both "shared" tools are included
      expect(allTools).toHaveLength(4);
      expect(allTools.filter(t => t.name === 'shared')).toHaveLength(2);

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('returns empty array when no servers started', () => {
      expect(manager.getAllTools()).toEqual([]);
    });
  });

  // =========================================================================
  // rebuildToolList (standalone)
  // =========================================================================

  describe('rebuildToolList', () => {
    it('clears previous warnings and tool map when called again', async () => {
      mockListTools
        .mockResolvedValueOnce({ tools: [makeToolDef('dup')] })
        .mockResolvedValueOnce({ tools: [makeToolDef('dup')] });

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.startAll([makeConfig('a'), makeConfig('b')]);

      expect(manager.getDuplicateWarnings()).toHaveLength(1);
      expect(manager.getToolServerMap().size).toBe(1);

      // Call rebuildToolList again to verify it resets
      manager.rebuildToolList();
      // After rebuild: same state since servers haven't changed
      expect(manager.getDuplicateWarnings()).toHaveLength(1);
      expect(manager.getToolServerMap().size).toBe(1);

      logSpy.mockRestore();
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  // =========================================================================
  // setScopeElevateHandler
  // =========================================================================

  describe('setScopeElevateHandler', () => {
    it('replaces the handler when called again', async () => {
      const handler1 = vi.fn().mockResolvedValue({ approved: false });
      const handler2 = vi.fn().mockResolvedValue({ approved: true, newCapabilities: ['full'] });

      manager.setScopeElevateHandler(handler1);
      await manager.callTool('_scope_elevate', { featureSet: 'a', label: 'a', reason: 'a', capabilities: [] });
      expect(handler1).toHaveBeenCalledTimes(1);

      manager.setScopeElevateHandler(handler2);
      const result = await manager.callTool('_scope_elevate', { featureSet: 'b', label: 'b', reason: 'b', capabilities: [] });
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler1).toHaveBeenCalledTimes(1); // not called again
      expect(JSON.parse(result.content)).toEqual({ approved: true, newCapabilities: ['full'] });
    });
  });
});
