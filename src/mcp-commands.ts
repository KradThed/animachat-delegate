/**
 * MCP server management: templates, interactive add, list, remove.
 * Used by `mcp add/list/remove` subcommands and `init` onboarding.
 */

import { resolve } from 'path';
import { readConfigRaw, updateConfig } from './config-utils.js';
import { promptText, promptSelect, promptConfirm } from './prompts.js';

// M5: Server name validation — same regex used in CLI and types.ts McpServerConfigSchema
export const SERVER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * M3: Parse shell-like arguments respecting quotes and escape sequences.
 * Handles "..." and '...' quoting, \" and \\ escapes (important for Windows paths).
 */
export function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    // Handle backslash escapes (outside single quotes)
    if (ch === '\\' && i + 1 < input.length && !(inQuote && quoteChar === "'")) {
      const next = input[i + 1];
      if (next === '"' || next === '\\' || next === "'") {
        current += next;
        i++;  // skip next char
        continue;
      }
    }

    if (!inQuote && (ch === '"' || ch === "'")) {
      inQuote = true;
      quoteChar = ch;
    } else if (inQuote && ch === quoteChar) {
      inQuote = false;
    } else if (!inQuote && /\s/.test(ch)) {
      if (current) { args.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

// =============================================================================
// Templates (verified on npm 2026-02-17, zero-config only)
// =============================================================================

interface McpTemplate {
  description: string;
  command: string;
  baseArgs: string[];
  prompts: { key: string; question: string; required?: boolean }[];
  buildArgs: (answers: Record<string, string>) => string[];
  buildEnv?: (answers: Record<string, string>) => Record<string, string> | undefined;
}

const templates: Record<string, McpTemplate> = {
  filesystem: {
    description: 'File read/write access',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    prompts: [{ key: 'paths', question: 'Paths to expose (comma-separated)', required: true }],
    buildArgs(answers) {
      const paths = answers.paths.split(',').map(p => p.trim()).filter(Boolean);
      return [...this.baseArgs, ...paths.map(p => resolve(p))];
    },
  },
  memory: {
    description: 'Persistent memory / knowledge graph',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-memory'],
    prompts: [],
    buildArgs() { return [...this.baseArgs]; },
  },
  'sequential-thinking': {
    description: 'Step-by-step reasoning aid',
    command: 'npx',
    baseArgs: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    prompts: [],
    buildArgs() { return [...this.baseArgs]; },
  },
};

// =============================================================================
// Interactive MCP Add
// =============================================================================

/**
 * Interactive MCP server addition with templates.
 * Shared by `mcp add` and `init` subcommands.
 * Returns true if a server was added, false if cancelled.
 */
export async function interactiveMcpAdd(configPathOverride?: string): Promise<boolean> {
  const templateNames = Object.keys(templates);
  const options = [
    ...templateNames.map(name => `${name} — ${templates[name].description}`),
    'custom — provide your own command',
  ];

  const choice = await promptSelect('Add MCP server:', options);
  if (choice === null) return false;

  let name: string;
  let command: string;
  let args: string[];
  let env: Record<string, string> | undefined;

  if (choice < templateNames.length) {
    // Template selected
    const templateName = templateNames[choice];
    const tmpl = templates[templateName];
    name = templateName;
    command = tmpl.command;

    // Gather template-specific answers
    const answers: Record<string, string> = {};
    for (const prompt of tmpl.prompts) {
      const answer = await promptText(prompt.question);
      if (answer === null) return false;
      if (prompt.required && !answer) {
        console.error(`${prompt.key} is required.`);
        return false;
      }
      answers[prompt.key] = answer;
    }

    args = tmpl.buildArgs(answers);
    env = tmpl.buildEnv?.(answers);
  } else {
    // Custom server
    const nameAnswer = await promptText('Server name');
    if (nameAnswer === null || !nameAnswer) return false;
    // M5: validate server name
    if (!SERVER_NAME_RE.test(nameAnswer)) {
      console.error('Invalid name. Use lowercase letters, digits, hyphens, underscores (max 63 chars).');
      return false;
    }
    name = nameAnswer;

    const commandAnswer = await promptText('Command', 'npx');
    if (commandAnswer === null) return false;
    command = commandAnswer;

    const argsAnswer = await promptText('Arguments (space-separated, supports "quoted strings")');
    if (argsAnswer === null) return false;
    // M3: quote-aware arg parsing
    args = argsAnswer ? parseShellArgs(argsAnswer) : [];

    // Optional env vars
    env = {};
    while (true) {
      const envKey = await promptText('Env var name (empty to skip)');
      if (envKey === null) return false;
      if (!envKey) break;
      const envVal = await promptText(`Value for ${envKey}`);
      if (envVal === null) return false;
      env[envKey] = envVal;
    }
    if (Object.keys(env).length === 0) env = undefined;
  }

  // BUG-11 fix: duplicate check moved inside updateConfig callback (runs under lock).
  // Previous code checked outside the lock, creating a TOCTOU race where two
  // concurrent `mcp add` calls could both pass the duplicate check.
  let duplicate = false;
  updateConfig(configPathOverride, (config) => {
    if (!config.mcp_servers) config.mcp_servers = [];

    if (config.mcp_servers.find((s: any) => s.name === name)) {
      duplicate = true;
      return; // don't modify — updateConfig writes back as-is
    }

    const entry: any = { name, command, args };
    if (env) entry.env = env;
    config.mcp_servers.push(entry);
  });

  if (duplicate) {
    console.error(`MCP server "${name}" already exists. Remove it first or choose another name.`);
    return false;
  }

  console.log(`Added MCP server "${name}".`);
  return true;
}

// =============================================================================
// List MCP Servers
// =============================================================================

/**
 * List configured MCP servers from delegate.yaml.
 * Shows env var keys only (never values).
 */
export function listMcpServers(configPathOverride?: string): void {
  const { path: cfgPath, data: config } = readConfigRaw(configPathOverride);
  const servers: any[] = config.mcp_servers || [];

  if (servers.length === 0) {
    console.log('No MCP servers configured.');
    console.log(`Config: ${cfgPath}`);
    return;
  }

  console.log(`MCP servers (${servers.length}):\n`);
  servers.forEach((s: any, i: number) => {
    const envKeys = s.env ? Object.keys(s.env) : [];
    console.log(`  ${i + 1}. ${s.name} — ${s.command} ${(s.args || []).join(' ')}`);
    if (envKeys.length > 0) {
      console.log(`     env: ${envKeys.join(', ')}`);
    }
  });
  console.log(`\nConfig: ${cfgPath}`);
}

// =============================================================================
// Remove MCP Server
// =============================================================================

/**
 * Remove an MCP server by name, with confirmation.
 * Returns true if removed, false if not found or cancelled.
 */
export async function removeMcpServer(name: string, configPathOverride?: string, skipConfirm = false): Promise<boolean> {
  const { data: config } = readConfigRaw(configPathOverride);
  const servers: any[] = config.mcp_servers || [];

  const index = servers.findIndex((s: any) => s.name === name);
  if (index === -1) {
    console.error(`MCP server "${name}" not found.`);
    console.error('Use "animachat-delegate mcp list" to see configured servers.');
    return false;
  }

  const server = servers[index];
  const desc = `${server.command} ${(server.args || []).join(' ')}`;

  if (!skipConfirm) {
    const confirmed = await promptConfirm(`Remove "${name}" (${desc})?`);
    if (confirmed === null || !confirmed) {
      console.log('Cancelled.');
      return false;
    }
  }

  updateConfig(configPathOverride, (cfg) => {
    const idx = cfg.mcp_servers.findIndex((s: any) => s.name === name);
    if (idx === -1) {
      console.error(`Server "${name}" not found in config (concurrent modification?).`);
      return;
    }
    cfg.mcp_servers.splice(idx, 1);
  });

  console.log(`Removed MCP server "${name}".`);
  return true;
}
