import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from './mcp/register-tools.js';
import { initialize } from './initialize.js';

const { wiki, exporter, media } = initialize();

// stdout is reserved for MCP messages; diagnostics go to stderr.
await serveStdio(() => createMcpServer(wiki, exporter, media));
