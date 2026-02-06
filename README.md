# Animachat Delegate

Remote tool execution agent for [Animachat](https://github.com/anima-research/animachat). Runs on your local machine and connects to the Animachat server via WebSocket.

## Features

- **MCP Host**: Run Model Context Protocol servers locally and expose their tools to AI participants
- **Webhooks**: Receive external triggers (GitLab, GitHub) and forward them to conversations
- **Secure**: Uses API keys or JWT tokens for authentication

## Installation

```bash
# Clone the repository
git clone https://github.com/your-username/animachat-delegate.git
cd animachat-delegate

# Install dependencies
npm install

# Build
npm run build
```

## Configuration

1. Copy the example config:
```bash
cp delegate.yaml.example delegate.yaml
```

2. Edit `delegate.yaml`:
   - Set your Animachat server URL
   - Add your API key (create one in Animachat Settings -> API Keys)
   - Configure MCP servers you want to run
   - Optionally enable webhooks

## Usage

```bash
# Development mode (with hot reload)
npm run dev

# Production
npm start

# Or with custom config path
npm start -- --config /path/to/delegate.yaml
```

## MCP Servers

The delegate can host any MCP-compatible server. Popular examples:

| Server | Command |
|--------|---------|
| Filesystem | `npx -y @modelcontextprotocol/server-filesystem /path` |
| GitHub | `npx -y @modelcontextprotocol/server-github` |
| Brave Search | `npx -y @modelcontextprotocol/server-brave-search` |
| Puppeteer | `npx -y @modelcontextprotocol/server-puppeteer` |

See [MCP Servers](https://github.com/modelcontextprotocol/servers) for more options.

## Authentication

Two authentication methods are supported:

### API Key (Recommended)
1. Go to Animachat Settings -> API Keys
2. Create a new key
3. Add to `delegate.yaml`:
```yaml
server:
  apiKey: "dak_your-key-here"
```

### JWT Token
1. Login to Animachat in browser
2. Open DevTools -> Application -> Local Storage
3. Copy the `token` value
4. Add to `delegate.yaml`:
```yaml
server:
  token: "eyJ..."
```

## License

MIT
