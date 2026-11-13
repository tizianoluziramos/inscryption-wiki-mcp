import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExportService } from '../src/services/export-service.js';

class FakeWiki {
  baseUrl = 'https://inscryption.fandom.com';
  processedPages = [];
  async info() { return { namespaces: { 0: { id: 0, name: '' } }, statistics: {} }; }
  async listPages({ cursor }) {
    if (cursor) throw new Error('Unexpected continuation');
    return { pages: [{ title: 'Stoat', pageid: 1 }, { title: 'Wolf', pageid: 2 }], nextCursor: null };
  }
  async getPage(title) {
    this.processedPages.push(title);
    return { title, wikitext: `{{Card|title=${title}}}` };
  }
  async listFiles({ cursor }) {
    if (cursor) throw new Error('Unexpected continuation');
    return { files: [{ name: 'Stoat.png', url: 'https://example.org/stoat.png' }], nextCursor: null };
  }
  async listCategories({ cursor }) {
    if (cursor) throw new Error('Unexpected continuation');
    return { categories: [{ category: 'Cards', size: 10 }], nextCursor: null };
  }
}

test('exports and resumes without duplicates; produces complete NDJSON', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-wiki-test-'));
  try {
    const wiki = new FakeWiki();
    const first = new ExportService(wiki, dir);
    const initial = await first.batch({ maxItems: 1 });
    assert.equal(initial.complete, false);
    assert.equal(initial.counts.pages, 1);

    const resumed = new ExportService(wiki, dir);
    let status;
    for (let i = 0; i < 20; i++) {
      status = await resumed.batch({ maxItems: 1 });
      if (status.complete) break;
    }
    assert.equal(status.complete, true);
    assert.deepEqual(status.counts, { pages: 2, files: 1, categories: 1, revisions: 0 });
    assert.deepEqual(wiki.processedPages, ['Stoat', 'Wolf']);
    const pages = (await readFile(path.join(dir, 'pages.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const files = (await readFile(path.join(dir, 'files.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const categories = (await readFile(path.join(dir, 'categories.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(pages.map((p) => p.title).sort(), ['Stoat', 'Wolf']);
    assert.equal(files[0].name, 'Stoat.png');
    assert.equal(categories[0].category, 'Cards');
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.counts.pages, 2);
    const again = await resumed.batch({ maxItems: 1 });
    assert.equal(again.complete, true);
    assert.equal(again.processed, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cannot resume with different export options', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-wiki-options-'));
  try {
    const exporter = new ExportService(new FakeWiki(), dir);
    await exporter.batch({ maxItems: 1 });
    await assert.rejects(exporter.batch({ maxItems: 1, includeHtml: true }), /different options/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
