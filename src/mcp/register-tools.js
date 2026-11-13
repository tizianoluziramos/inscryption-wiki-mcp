import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

const cursor = z.string().max(8192).optional();
const title = z.string().trim().min(1).max(2000);
const limit = z.number().int().min(1).max(50).default(20);

function jsonResult(payload, maxChars = 180000) {
  const full = JSON.stringify(payload);
  if (full.length <= maxChars) return { content: [{ type: 'text', text: full }] };
  return { content: [{ type: 'text', text: JSON.stringify({
    truncated: true,
    actualChars: full.length,
    preview: full.slice(0, maxChars - 250),
    note: 'Tool output too large. Use export_batch for a full local copy, or request fewer fields.',
  }) }] };
}

function wrap(work) {
  return async (args) => {
    try {
      return jsonResult(await work(args));
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
          status: error?.status ?? null,
          code: error?.code ?? null,
        }) }],
      };
    }
  };
}

export function createMcpServer(wiki, exporter, media) {
  const server = new McpServer({ name: 'inscryption-wiki', version: '1.0.0' });

  server.registerTool('wiki_info', {
    description: 'Read MediaWiki site information, namespace IDs, license information and statistics.',
    inputSchema: z.object({}),
  }, wrap(async () => wiki.info()));

  server.registerTool('search_pages', {
    description: 'Full-text search articles across the Inscryption Wiki. Paginates with nextCursor.',
    inputSchema: z.object({ query: title, limit, cursor }),
  }, wrap(({ query, limit, cursor }) => wiki.search(query, { limit, cursor })));

  server.registerTool('list_pages', {
    description: 'Enumerate pages within any MediaWiki namespace (0=articles, 6=files, 10=templates, 14=categories).',
    inputSchema: z.object({ namespace: z.number().int().min(0).default(0), limit: limit.default(50), cursor,
      redirects: z.boolean().default(true) }),
  }, wrap((args) => wiki.listPages(args)));

  server.registerTool('get_page', {
    description: 'Read full page wikitext, revision metadata, categories, templates, image references and links; optional rendered HTML.',
    inputSchema: z.object({
      title,
      includeWikitext: z.boolean().default(true),
      includeRelations: z.boolean().default(true),
      includeHtml: z.boolean().default(false),
    }),
  }, wrap(({ title, ...options }) => wiki.getPage(title, options)));

  server.registerTool('parse_page', {
    description: 'Get rendered HTML and section outline for a wiki page.',
    inputSchema: z.object({ title }),
  }, wrap(({ title }) => wiki.parsedPage(title)));

  server.registerTool('list_categories', {
    description: 'Enumerate all wiki category names, including categories without a dedicated category page.',
    inputSchema: z.object({ limit: limit.default(50), cursor }),
  }, wrap((args) => wiki.listCategories(args)));

  server.registerTool('category_members', {
    description: 'List all pages, files or subcategories belonging to a category.',
    inputSchema: z.object({ category: title, limit: limit.default(50), cursor,
      type: z.enum(['all', 'page', 'file', 'subcat']).default('all') }),
  }, wrap(({ category, ...options }) => wiki.categoryMembers(category, options)));

  server.registerTool('list_files', {
    description: 'Enumerate all uploaded files and image metadata with source URLs (no binary downloads).',
    inputSchema: z.object({ limit: limit.default(50), cursor }),
  }, wrap((args) => wiki.listFiles(args)));

  server.registerTool('get_file', {
    description: 'Read image/file metadata including dimensions, source URL, hash, licensing and attribution when published.',
    inputSchema: z.object({ title }),
  }, wrap(({ title }) => wiki.fileInfo(title)));

  server.registerTool('backlinks', {
    description: 'Find pages linking to a given page.',
    inputSchema: z.object({ title, limit: limit.default(50), cursor }),
  }, wrap(({ title, ...options }) => wiki.backlinks(title, options)));

  server.registerTool('list_revisions', {
    description: 'Read paginated edit history; set includeContent=true to retrieve historical revision wikitext.',
    inputSchema: z.object({ title, limit: limit.default(50), cursor, includeContent: z.boolean().default(false) }),
  }, wrap(({ title, includeContent, ...options }) => wiki.listRevisions(title, { ...options, content: includeContent })));

  server.registerTool('get_revision', {
    description: 'Get the wikitext and metadata of a particular public revision ID.',
    inputSchema: z.object({ revisionId: z.number().int().positive() }),
  }, wrap(({ revisionId }) => wiki.getRevision(revisionId)));

  server.registerTool('export_batch', {
    description: 'Export a bounded batch to JSONL on disk. Repeat until complete=true. Checkpointed and resumable; use CLI for all pages automatically. Options must remain unchanged across batches.',
    inputSchema: z.object({
      maxItems: z.number().int().min(1).max(50).default(10),
      includeHtml: z.boolean().default(false),
      includeRelations: z.boolean().default(true),
      includeHistory: z.boolean().default(false),
      includeFiles: z.boolean().default(true),
      includeCategories: z.boolean().default(true),
      namespace: z.number().int().min(0).nullable().default(null),
    }),
  }, wrap((args) => exporter.batch(args)));

  server.registerTool('export_status', {
    description: 'Inspect the resumable wiki export checkpoint without making any network requests.',
    inputSchema: z.object({}),
  }, wrap(async () => exporter.status()));

  server.registerTool('download_media_batch', {
    description: 'Download a bounded batch of public Fandom-hosted image, audio and other media binaries to the configured export directory. Requires a completed wiki export; repeat until completed=true.',
    inputSchema: z.object({ maxItems: z.number().int().min(1).max(50).default(10) }),
  }, wrap((args) => media.batch(args)));

  server.registerTool('media_status', {
    description: 'Inspect the public media download checkpoint without making any network requests.',
    inputSchema: z.object({}),
  }, wrap(async () => media.status()));

  server.registerResource('siteinfo', 'wiki://inscryption/siteinfo', {
    description: 'Live Inscryption Wiki site information (JSON)', mimeType: 'application/json',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await wiki.info()) }] }));

  server.registerResource('page', new ResourceTemplate('wiki://inscryption/page/{title}', { list: undefined }), {
    description: 'Read a page by URI-encoded wiki title', mimeType: 'application/json',
  }, async (uri, { title }) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await wiki.getPage(String(title))) }],
  }));

  return server;
}
