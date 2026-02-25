import { describe, it, expect } from 'vitest';
import {
  ToolDefinitionSchema,
  DelegateAuthResultSchema,
  ToolCallRequestSchema,
  TriggerInferenceResultSchema,
  PongSchema,
  ToolManifestAckSchema,
  ServerMessageSchema,
  McpServerConfigSchema,
  WebhookEndpointSchema,
  DelegateConfigSchema,
} from '../src/types.js';

// ─── ToolDefinitionSchema ────────────────────────────────────────

describe('ToolDefinitionSchema', () => {
  it('accepts a valid definition with all fields', () => {
    const input = {
      name: 'read_file',
      description: 'Reads a file from disk',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      serverName: 'filesystem',
    };
    const result = ToolDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('read_file');
      expect(result.data.serverName).toBe('filesystem');
      expect(result.data.inputSchema.required).toEqual(['path']);
    }
  });

  it('accepts a valid definition without optional serverName', () => {
    const input = {
      name: 'echo',
      description: 'Echoes input',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    };
    const result = ToolDefinitionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.serverName).toBeUndefined();
      expect(result.data.inputSchema.required).toBeUndefined();
    }
  });

  it('rejects when name is missing', () => {
    const input = {
      description: 'No name',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    };
    const result = ToolDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when inputSchema.type is not "object"', () => {
    const input = {
      name: 'bad',
      description: 'Wrong type',
      inputSchema: {
        type: 'array',
        properties: {},
      },
    };
    const result = ToolDefinitionSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── DelegateAuthResultSchema ────────────────────────────────────

describe('DelegateAuthResultSchema', () => {
  it('accepts a successful auth result', () => {
    const input = {
      type: 'delegate_auth_result' as const,
      success: true,
      userId: 'user-123',
      sessionId: 'sess-abc',
    };
    const result = DelegateAuthResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(true);
      expect(result.data.userId).toBe('user-123');
      expect(result.data.sessionId).toBe('sess-abc');
      expect(result.data.error).toBeUndefined();
    }
  });

  it('accepts a failure auth result with error', () => {
    const input = {
      type: 'delegate_auth_result' as const,
      success: false,
      error: 'Invalid token',
    };
    const result = DelegateAuthResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(false);
      expect(result.data.error).toBe('Invalid token');
      expect(result.data.userId).toBeUndefined();
      expect(result.data.sessionId).toBeUndefined();
    }
  });

  it('accepts minimal auth result (no optional fields)', () => {
    const input = {
      type: 'delegate_auth_result' as const,
      success: true,
    };
    const result = DelegateAuthResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects when type is wrong', () => {
    const input = {
      type: 'wrong_type',
      success: true,
    };
    const result = DelegateAuthResultSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when success is missing', () => {
    const input = {
      type: 'delegate_auth_result' as const,
    };
    const result = DelegateAuthResultSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── ToolCallRequestSchema ───────────────────────────────────────

describe('ToolCallRequestSchema', () => {
  it('accepts a valid request with all fields', () => {
    const input = {
      type: 'tool_call_request' as const,
      requestId: 'req-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      tool: {
        id: 'tool-1',
        name: 'read_file',
        input: { path: '/tmp/test.txt' },
      },
      timeout: 60000,
    };
    const result = ToolCallRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout).toBe(60000);
      expect(result.data.messageId).toBe('msg-1');
      expect(result.data.tool.name).toBe('read_file');
    }
  });

  it('defaults timeout to 30000 when omitted', () => {
    const input = {
      type: 'tool_call_request' as const,
      requestId: 'req-2',
      conversationId: 'conv-2',
      tool: {
        id: 'tool-2',
        name: 'echo',
        input: { message: 'hello' },
      },
    };
    const result = ToolCallRequestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timeout).toBe(30000);
      expect(result.data.messageId).toBeUndefined();
    }
  });

  it('rejects when tool.name is missing', () => {
    const input = {
      type: 'tool_call_request' as const,
      requestId: 'req-3',
      conversationId: 'conv-3',
      tool: {
        id: 'tool-3',
        input: { a: 1 },
      },
    };
    const result = ToolCallRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when requestId is missing', () => {
    const input = {
      type: 'tool_call_request' as const,
      conversationId: 'conv-4',
      tool: {
        id: 'tool-4',
        name: 'some_tool',
        input: {},
      },
    };
    const result = ToolCallRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when tool object is missing entirely', () => {
    const input = {
      type: 'tool_call_request' as const,
      requestId: 'req-5',
      conversationId: 'conv-5',
    };
    const result = ToolCallRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── TriggerInferenceResultSchema ────────────────────────────────

describe('TriggerInferenceResultSchema', () => {
  it('accepts a successful result with all fields', () => {
    const input = {
      type: 'trigger_inference_result' as const,
      triggerId: 'trig-1',
      success: true,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      response: 'Done!',
    };
    const result = TriggerInferenceResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.response).toBe('Done!');
      expect(result.data.error).toBeUndefined();
    }
  });

  it('accepts a failure result with error', () => {
    const input = {
      type: 'trigger_inference_result' as const,
      triggerId: 'trig-2',
      success: false,
      error: 'Inference failed',
    };
    const result = TriggerInferenceResultSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.success).toBe(false);
      expect(result.data.error).toBe('Inference failed');
    }
  });

  it('accepts minimal result (only required fields)', () => {
    const input = {
      type: 'trigger_inference_result' as const,
      triggerId: 'trig-3',
      success: true,
    };
    const result = TriggerInferenceResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// ─── PongSchema ──────────────────────────────────────────────────

describe('PongSchema', () => {
  it('accepts a valid pong', () => {
    const input = {
      type: 'pong' as const,
      timestamp: Date.now(),
    };
    const result = PongSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('pong');
      expect(typeof result.data.timestamp).toBe('number');
    }
  });

  it('rejects when timestamp is missing', () => {
    const input = {
      type: 'pong' as const,
    };
    const result = PongSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when timestamp is not a number', () => {
    const input = {
      type: 'pong' as const,
      timestamp: '1234567890',
    };
    const result = PongSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── ToolManifestAckSchema ───────────────────────────────────────

describe('ToolManifestAckSchema', () => {
  it('accepts a valid ack', () => {
    const input = {
      type: 'tool_manifest_ack' as const,
      toolCount: 3,
      tools: ['read_file', 'write_file', 'list_dir'],
    };
    const result = ToolManifestAckSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolCount).toBe(3);
      expect(result.data.tools).toHaveLength(3);
    }
  });

  it('accepts an ack with zero tools', () => {
    const input = {
      type: 'tool_manifest_ack' as const,
      toolCount: 0,
      tools: [],
    };
    const result = ToolManifestAckSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects when tools array is missing', () => {
    const input = {
      type: 'tool_manifest_ack' as const,
      toolCount: 1,
    };
    const result = ToolManifestAckSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── ServerMessageSchema (discriminated union) ───────────────────

describe('ServerMessageSchema', () => {
  it('routes delegate_auth_result correctly', () => {
    const input = {
      type: 'delegate_auth_result' as const,
      success: true,
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('delegate_auth_result');
    }
  });

  it('routes tool_call_request correctly', () => {
    const input = {
      type: 'tool_call_request' as const,
      requestId: 'req-1',
      conversationId: 'conv-1',
      tool: {
        id: 'tool-1',
        name: 'echo',
        input: {},
      },
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('tool_call_request');
    }
  });

  it('routes trigger_inference_result correctly', () => {
    const input = {
      type: 'trigger_inference_result' as const,
      triggerId: 'trig-1',
      success: true,
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('trigger_inference_result');
    }
  });

  it('routes pong correctly', () => {
    const input = {
      type: 'pong' as const,
      timestamp: 1234567890,
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('pong');
    }
  });

  it('routes tool_manifest_ack correctly', () => {
    const input = {
      type: 'tool_manifest_ack' as const,
      toolCount: 0,
      tools: [],
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('tool_manifest_ack');
    }
  });

  it('rejects an unknown type', () => {
    const input = {
      type: 'unknown_message_type',
      data: 'something',
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when type field is missing entirely', () => {
    const input = {
      success: true,
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('validates nested fields for the matched discriminant', () => {
    // type is tool_call_request but missing required requestId
    const input = {
      type: 'tool_call_request' as const,
      conversationId: 'conv-1',
      tool: {
        id: 'tool-1',
        name: 'echo',
        input: {},
      },
    };
    const result = ServerMessageSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── McpServerConfigSchema ───────────────────────────────────────

describe('McpServerConfigSchema', () => {
  it('accepts a full config with args and env', () => {
    const input = {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { HOME: '/root', NODE_ENV: 'production' },
    };
    const result = McpServerConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
      expect(result.data.env).toEqual({ HOME: '/root', NODE_ENV: 'production' });
    }
  });

  it('defaults args to [] when omitted', () => {
    const input = {
      name: 'minimal',
      command: 'node',
    };
    const result = McpServerConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.args).toEqual([]);
      expect(result.data.env).toBeUndefined();
    }
  });

  it('accepts config without env', () => {
    const input = {
      name: 'no-env',
      command: 'python',
      args: ['server.py'],
    };
    const result = McpServerConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.env).toBeUndefined();
    }
  });

  it('rejects when name is missing', () => {
    const input = {
      command: 'node',
    };
    const result = McpServerConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when command is missing', () => {
    const input = {
      name: 'no-command',
    };
    const result = McpServerConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── WebhookEndpointSchema ───────────────────────────────────────

describe('WebhookEndpointSchema', () => {
  it('accepts a valid endpoint with all fields', () => {
    const input = {
      source: 'github',
      path: '/webhooks/github',
      secret: 'whsec_abc123',
      conversation_id: 'conv-1',
      participant_id: 'part-1',
    };
    const result = WebhookEndpointSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('github');
      expect(result.data.path).toBe('/webhooks/github');
      expect(result.data.secret).toBe('whsec_abc123');
      expect(result.data.conversation_id).toBe('conv-1');
      expect(result.data.participant_id).toBe('part-1');
    }
  });

  it('accepts a minimal endpoint with only required fields', () => {
    const input = {
      source: 'stripe',
      path: '/webhooks/stripe',
    };
    const result = WebhookEndpointSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.secret).toBeUndefined();
      expect(result.data.conversation_id).toBeUndefined();
      expect(result.data.participant_id).toBeUndefined();
    }
  });

  it('rejects when source is missing', () => {
    const input = {
      path: '/webhooks/test',
    };
    const result = WebhookEndpointSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when path is missing', () => {
    const input = {
      source: 'test',
    };
    const result = WebhookEndpointSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

// ─── DelegateConfigSchema ────────────────────────────────────────

describe('DelegateConfigSchema', () => {
  const minimalConfig = {
    server: {
      url: 'wss://example.com/ws',
      token: 'my-token',
    },
    delegate: {
      id: 'delegate-1',
    },
  };

  it('accepts minimal config and applies all defaults', () => {
    const result = DelegateConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delegate.capabilities).toEqual(['mcp_host']);
      expect(result.data.mcp_servers).toEqual([]);
      expect(result.data.webhooks).toEqual({
        enabled: false,
        port: 8080,
        endpoints: [],
        rateLimits: { windowMs: 60_000, maxPerWindow: 60 },
      });
    }
  });

  it('accepts full config with all sections populated', () => {
    const input = {
      server: {
        url: 'wss://example.com/ws',
        token: 'my-token',
      },
      delegate: {
        id: 'delegate-1',
        capabilities: ['mcp_host', 'webhooks'],
      },
      mcp_servers: [
        {
          name: 'filesystem',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
        },
      ],
      webhooks: {
        enabled: true,
        port: 9090,
        endpoints: [
          {
            source: 'github',
            path: '/webhooks/github',
            secret: 'abc',
          },
        ],
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delegate.capabilities).toEqual(['mcp_host', 'webhooks']);
      expect(result.data.mcp_servers).toHaveLength(1);
      expect(result.data.webhooks.enabled).toBe(true);
      expect(result.data.webhooks.port).toBe(9090);
      expect(result.data.webhooks.endpoints).toHaveLength(1);
    }
  });

  it('accepts empty mcp_servers array', () => {
    const input = {
      ...minimalConfig,
      mcp_servers: [],
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcp_servers).toEqual([]);
    }
  });

  it('defaults webhooks when the section is omitted', () => {
    const result = DelegateConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhooks.enabled).toBe(false);
      expect(result.data.webhooks.port).toBe(8080);
      expect(result.data.webhooks.endpoints).toEqual([]);
    }
  });

  it('defaults webhooks.port and webhooks.enabled when webhooks is partially provided', () => {
    const input = {
      ...minimalConfig,
      webhooks: {
        endpoints: [
          {
            source: 'test',
            path: '/test',
          },
        ],
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhooks.enabled).toBe(false);
      expect(result.data.webhooks.port).toBe(8080);
      expect(result.data.webhooks.endpoints).toHaveLength(1);
    }
  });

  it('defaults webhooks.rateLimits when omitted', () => {
    const result = DelegateConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhooks.rateLimits).toEqual({
        windowMs: 60_000,
        maxPerWindow: 60,
      });
    }
  });

  it('accepts custom webhooks.rateLimits', () => {
    const input = {
      ...minimalConfig,
      webhooks: {
        enabled: true,
        port: 9090,
        endpoints: [],
        rateLimits: {
          windowMs: 10_000,
          maxPerWindow: 5,
        },
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhooks.rateLimits.windowMs).toBe(10_000);
      expect(result.data.webhooks.rateLimits.maxPerWindow).toBe(5);
    }
  });

  it('defaults individual rateLimits fields when partially provided', () => {
    const input = {
      ...minimalConfig,
      webhooks: {
        rateLimits: {
          maxPerWindow: 10,
        },
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.webhooks.rateLimits.windowMs).toBe(60_000); // default
      expect(result.data.webhooks.rateLimits.maxPerWindow).toBe(10);  // custom
    }
  });

  it('rejects when server.url is missing', () => {
    const input = {
      server: {
        token: 'my-token',
      },
      delegate: {
        id: 'delegate-1',
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when server.token is missing', () => {
    const input = {
      server: {
        url: 'wss://example.com/ws',
      },
      delegate: {
        id: 'delegate-1',
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when delegate.id is missing', () => {
    const input = {
      server: {
        url: 'wss://example.com/ws',
        token: 'my-token',
      },
      delegate: {},
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when server section is missing entirely', () => {
    const input = {
      delegate: {
        id: 'delegate-1',
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects when delegate section is missing entirely', () => {
    const input = {
      server: {
        url: 'wss://example.com/ws',
        token: 'my-token',
      },
    };
    const result = DelegateConfigSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('defaults delegate.capabilities to ["mcp_host"] when omitted', () => {
    const result = DelegateConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.delegate.capabilities).toEqual(['mcp_host']);
    }
  });
});
