/**
 * Stateful MCP Server — State & Multi-Content Testing
 *
 * Tests stateful tool behavior and multiple content block types.
 * State is in-memory (resets on server restart).
 *
 * Tools: counter_increment, counter_get, counter_reset,
 *        note_save, note_get, multi_content
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'stateful-test-server', version: '1.0.0' },
);

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------
const counters = new Map<string, number>();
const notes = new Map<string, string>();

// ---------------------------------------------------------------------------
// Tool: counter_increment — increment per-key counter
// ---------------------------------------------------------------------------
server.registerTool('counter_increment', {
  description: 'Increment a named counter by amount (default 1)',
  inputSchema: {
    key: z.string().describe('Counter name'),
    amount: z.number().optional().describe('Amount to increment by (default: 1)'),
  },
}, async (args) => {
  const prev = counters.get(args.key) || 0;
  const next = prev + (args.amount ?? 1);
  counters.set(args.key, next);
  return {
    content: [{ type: 'text', text: `${args.key}: ${prev} → ${next}` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: counter_get — read counter value
// ---------------------------------------------------------------------------
server.registerTool('counter_get', {
  description: 'Get the current value of a named counter',
  inputSchema: {
    key: z.string().describe('Counter name'),
  },
}, async (args) => {
  const value = counters.get(args.key);
  if (value === undefined) {
    return {
      content: [{ type: 'text', text: `Counter "${args.key}" does not exist` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: `${args.key} = ${value}` }],
  };
});

// ---------------------------------------------------------------------------
// Tool: counter_reset — reset counter to 0
// ---------------------------------------------------------------------------
server.registerTool('counter_reset', {
  description: 'Reset a named counter to 0',
  inputSchema: {
    key: z.string().describe('Counter name'),
  },
}, async (args) => {
  const existed = counters.has(args.key);
  counters.delete(args.key);
  return {
    content: [{
      type: 'text',
      text: existed
        ? `Counter "${args.key}" reset`
        : `Counter "${args.key}" did not exist (no-op)`,
    }],
  };
});

// ---------------------------------------------------------------------------
// Tool: note_save — save a text note by key
// ---------------------------------------------------------------------------
server.registerTool('note_save', {
  description: 'Save a text note by key (overwrites if exists)',
  inputSchema: {
    key: z.string().describe('Note key/name'),
    text: z.string().describe('Note content'),
  },
}, async (args) => {
  const isNew = !notes.has(args.key);
  notes.set(args.key, args.text);
  return {
    content: [{
      type: 'text',
      text: isNew
        ? `Note "${args.key}" saved (${args.text.length} chars)`
        : `Note "${args.key}" updated (${args.text.length} chars)`,
    }],
  };
});

// ---------------------------------------------------------------------------
// Tool: note_get — retrieve a saved note
// ---------------------------------------------------------------------------
server.registerTool('note_get', {
  description: 'Retrieve a saved note by key',
  inputSchema: {
    key: z.string().describe('Note key/name'),
  },
}, async (args) => {
  const text = notes.get(args.key);
  if (text === undefined) {
    return {
      content: [{ type: 'text', text: `Note "${args.key}" not found` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text }],
  };
});

// ---------------------------------------------------------------------------
// Tool: multi_content — return multiple content blocks
// ---------------------------------------------------------------------------

// Tiny 1x1 red PNG as base64 (for image content block testing)
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

server.registerTool('multi_content', {
  description: 'Return multiple content blocks (text + optional image) for content handling testing',
  inputSchema: {
    include_image: z.boolean().optional().describe('Include a test image block (default: false)'),
  },
}, async (args) => {
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
    { type: 'text', text: 'Block 1: Hello from stateful server' },
    { type: 'text', text: 'Block 2: This is the second text block' },
  ];

  if (args.include_image) {
    content.push({
      type: 'image',
      data: TINY_PNG_BASE64,
      mimeType: 'image/png',
    });
    content.push({
      type: 'text',
      text: 'Block 4: Text after image',
    });
  }

  return { content };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
