/**
 * Echo MCP Server — Basic Tool Execution Testing
 *
 * Tests the fundamental tool call pipeline:
 * spawn → listTools → callTool → response
 *
 * Tools: echo, get_time, add, fail, slow
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'echo-test-server', version: '1.0.0' },
);

// ---------------------------------------------------------------------------
// Tool: echo — round-trip text
// ---------------------------------------------------------------------------
server.registerTool('echo', {
  description: 'Echo back the input text (round-trip test)',
  inputSchema: {
    text: z.string().describe('Text to echo back'),
  },
}, async (args) => {
  return {
    content: [{ type: 'text', text: args.text }],
  };
});

// ---------------------------------------------------------------------------
// Tool: get_time — no-arg tool
// ---------------------------------------------------------------------------
server.registerTool('get_time', {
  description: 'Get current server time as ISO string',
}, async () => {
  return {
    content: [{ type: 'text', text: new Date().toISOString() }],
  };
});

// ---------------------------------------------------------------------------
// Tool: add — typed numeric args
// ---------------------------------------------------------------------------
server.registerTool('add', {
  description: 'Add two numbers together',
  inputSchema: {
    a: z.number().describe('First number'),
    b: z.number().describe('Second number'),
  },
}, async (args) => {
  const result = args.a + args.b;
  return {
    content: [{ type: 'text', text: `${args.a} + ${args.b} = ${result}` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: fail — always returns error
// ---------------------------------------------------------------------------
server.registerTool('fail', {
  description: 'Always returns an error (error path testing)',
  inputSchema: {
    message: z.string().optional().describe('Custom error message'),
  },
}, async (args) => {
  return {
    content: [{ type: 'text', text: args.message || 'Intentional test error' }],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// Tool: slow — configurable delay
// ---------------------------------------------------------------------------
server.registerTool('slow', {
  description: 'Wait for specified milliseconds before responding (timeout testing)',
  inputSchema: {
    delay_ms: z.number().min(0).max(60000).describe('Delay in milliseconds (max 60s)'),
  },
}, async (args) => {
  await new Promise(resolve => setTimeout(resolve, args.delay_ms));
  return {
    content: [{ type: 'text', text: `Done after ${args.delay_ms}ms` }],
  };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
