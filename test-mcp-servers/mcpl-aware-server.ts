/**
 * MCPL-Aware MCP Server — MCPL Context Testing
 *
 * This server is configured with `acceptsMcplContext: true` in delegate.yaml.
 * When called through an inference chain, the delegate injects `_mcpl` field
 * into tool input with chain/frame tracking context.
 *
 * Tests:
 * - _mcpl context injection (chainId, frameId)
 * - Scope elevation request pattern
 * - Chain info extraction
 *
 * Tools: check_mcpl_context, request_elevation, get_chain_info
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'mcpl-aware-test-server', version: '1.0.0' },
);

// ---------------------------------------------------------------------------
// Tool: check_mcpl_context — echo _mcpl field if present
// ---------------------------------------------------------------------------
server.registerTool('check_mcpl_context', {
  description: 'Check if MCPL context was injected into tool input. Returns the _mcpl field value if present.',
  inputSchema: {
    message: z.string().describe('A test message'),
    // _mcpl is injected by delegate, not declared in schema
    // but will appear in raw args if acceptsMcplContext: true
    _mcpl: z.object({
      v: z.number(),
      chainId: z.string(),
      frameId: z.string(),
    }).optional().describe('MCPL context (injected by delegate, do not pass manually)'),
  },
}, async (args) => {
  const mcpl = args._mcpl;

  if (mcpl) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          has_mcpl: true,
          version: mcpl.v,
          chainId: mcpl.chainId,
          frameId: mcpl.frameId,
          message: args.message,
        }, null, 2),
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        has_mcpl: false,
        message: args.message,
        note: 'No _mcpl context injected. This is expected when called outside an inference chain or when acceptsMcplContext is false.',
      }, null, 2),
    }],
  };
});

// ---------------------------------------------------------------------------
// Tool: request_elevation — describes what elevation would be requested
// ---------------------------------------------------------------------------
server.registerTool('request_elevation', {
  description: 'Describe what capability elevation would be requested. In real usage, the agent would call the _scope_elevate virtual tool.',
  inputSchema: {
    feature_set: z.string().describe('Feature set label to elevate'),
    reason: z.string().describe('Why elevation is needed'),
    capabilities: z.array(z.string()).optional().describe('Specific capabilities to request'),
  },
}, async (args) => {
  // In a real scenario, the MCP server would need the agent to call
  // _scope_elevate on its behalf. This tool just reports what would be
  // requested, useful for testing the request format.
  const elevation = {
    action: 'scope_elevate',
    featureSet: args.feature_set,
    reason: args.reason,
    requestedCapabilities: args.capabilities || ['context_hooks', 'push_events'],
    instruction: 'To actually elevate, the agent should call the _scope_elevate virtual tool with these parameters.',
  };

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(elevation, null, 2),
    }],
  };
});

// ---------------------------------------------------------------------------
// Tool: get_chain_info — extract chain/frame from _mcpl
// ---------------------------------------------------------------------------
server.registerTool('get_chain_info', {
  description: 'Extract chain and frame IDs from injected MCPL context. Returns "no context" if not in an inference chain.',
  inputSchema: {
    _mcpl: z.object({
      v: z.number(),
      chainId: z.string(),
      frameId: z.string(),
    }).optional().describe('MCPL context (injected by delegate)'),
  },
}, async (args) => {
  const mcpl = args._mcpl;

  if (!mcpl) {
    return {
      content: [{
        type: 'text',
        text: 'No MCPL context available. Tool was called outside an inference chain or acceptsMcplContext is disabled.',
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: [
        `Chain ID: ${mcpl.chainId}`,
        `Frame ID: ${mcpl.frameId}`,
        `Protocol version: ${mcpl.v}`,
      ].join('\n'),
    }],
  };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
