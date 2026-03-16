# Test MCP Servers

Local MCP servers for testing the MCPL/delegate pipeline without external dependencies.

## Servers

### echo-server (5 tools)
Basic tool call pipeline testing.

| Tool | Input | Description |
|------|-------|-------------|
| `echo` | `{ text: string }` | Echo back input text |
| `get_time` | none | Current server time (ISO) |
| `add` | `{ a: number, b: number }` | Add two numbers |
| `fail` | `{ message?: string }` | Always returns error |
| `slow` | `{ delay_ms: number }` | Wait N ms before responding |

### stateful-server (6 tools)
Stateful tools and multi-content blocks.

| Tool | Input | Description |
|------|-------|-------------|
| `counter_increment` | `{ key, amount? }` | Increment named counter |
| `counter_get` | `{ key }` | Get counter value |
| `counter_reset` | `{ key }` | Reset counter to 0 |
| `note_save` | `{ key, text }` | Save text note |
| `note_get` | `{ key }` | Retrieve saved note |
| `multi_content` | `{ include_image? }` | Multiple content blocks |

### mcpl-aware-server (3 tools)
MCPL context injection testing. Configured with `acceptsMcplContext: true`.

| Tool | Input | Description |
|------|-------|-------------|
| `check_mcpl_context` | `{ message }` | Echo `_mcpl` field if injected |
| `request_elevation` | `{ feature_set, reason }` | Describe elevation request |
| `get_chain_info` | none | Extract chain/frame IDs |

## Usage

### List tools (quick test)
```bash
npx tsx src/index.ts --config delegate-test.yaml --list-tools
```

### Run delegate with test servers
```bash
# Set token first
export DELEGATE_TOKEN=dak_your_key_here

npx tsx src/index.ts --config delegate-test.yaml
```

### Test individual server
```bash
# Starts MCP server on stdio (Ctrl+C to exit)
npx tsx test-mcp-servers/echo-server.ts
```

## What Each Server Tests

- **echo**: Tool discovery, arg validation, error responses, timeout behavior
- **stateful**: In-process state persistence, multi-content-block responses (text + image)
- **mcpl-aware**: `_mcpl` context injection, chain/frame ID extraction, scope elevation patterns
