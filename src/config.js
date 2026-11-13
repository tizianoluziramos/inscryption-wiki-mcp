import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

// Resolve .env relative to the repository, regardless of the MCP client's cwd.
try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

function integerEnv(name, fallback, { min = 0, max = 300000 } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function loadConfig() {
  const baseUrl = new URL(process.env.WIKI_BASE_URL ?? 'https://inscryption.fandom.com');
  if (baseUrl.protocol !== 'https:') throw new Error('WIKI_BASE_URL must use HTTPS');
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('WIKI_BASE_URL must not include credentials, query parameters or fragment');
  }

  const apiUrl = new URL(process.env.WIKI_API_URL ?? new URL('/api.php', baseUrl));
  if (apiUrl.protocol !== 'https:' || apiUrl.origin !== baseUrl.origin || apiUrl.pathname !== '/api.php') {
    throw new Error('WIKI_API_URL must be https://<same-wiki-host>/api.php');
  }

  return Object.freeze({
    baseUrl: baseUrl.origin,
    apiUrl: apiUrl.href,
    userAgent: process.env.WIKI_USER_AGENT ?? 'InscryptionWikiMCP/1.0 (read-only MediaWiki client)',
    minDelayMs: integerEnv('WIKI_MIN_DELAY_MS', 1000, { max: 60000 }),
    timeoutMs: integerEnv('WIKI_REQUEST_TIMEOUT_MS', 20000, { min: 1000 }),
    maxRetries: integerEnv('WIKI_MAX_RETRIES', 3, { max: 8 }),
    exportDir: path.resolve(process.env.WIKI_EXPORT_DIR ?? './data/inscryption-wiki'),
  });
}
