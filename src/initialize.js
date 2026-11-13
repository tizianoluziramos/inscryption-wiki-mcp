import { loadConfig } from './config.js';
import { MediaWikiClient } from './api/mediawiki-client.js';
import { WikiService } from './services/wiki-service.js';
import { ExportService } from './services/export-service.js';
import { MediaDownloadService } from './services/media-download-service.js';

export function initialize() {
  const config = loadConfig();
  const client = new MediaWikiClient(config);
  const wiki = new WikiService(client, config.baseUrl);
  const exporter = new ExportService(wiki, config.exportDir);
  const media = new MediaDownloadService(config.exportDir, {
    delayMs: config.minDelayMs,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    userAgent: config.userAgent,
  });
  return { config, client, wiki, exporter, media };
}
