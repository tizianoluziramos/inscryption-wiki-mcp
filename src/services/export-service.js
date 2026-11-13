import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fileKey(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function atomicWrite(destination, content) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.tmp`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, destination);
}

async function writeJson(destination, content) {
  await atomicWrite(destination, json(content));
}

const DEFAULT_OPTIONS = Object.freeze({
  includeHtml: false,
  includeRelations: true,
  includeHistory: false,
  includeFiles: true,
  includeCategories: true,
  namespace: null,
});

export class ExportService {
  constructor(wiki, rootDir) {
    this.wiki = wiki;
    this.rootDir = path.resolve(rootDir);
  }

  async #load(options) {
    const stateFile = path.join(this.rootDir, 'checkpoint.json');
    if (await exists(stateFile)) {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      if (state.version !== 1 || JSON.stringify(state.options) !== JSON.stringify(options)) {
        throw new Error('An export with different options already exists in WIKI_EXPORT_DIR; select another directory to start over');
      }
      return state;
    }
    const info = await this.wiki.info();
    let namespaces = Object.keys(info.namespaces ?? {})
      .map(Number)
      .filter((id) => Number.isInteger(id) && id >= 0)
      .sort((a, b) => a - b);
    if (options.namespace !== null) namespaces = [options.namespace];
    if (namespaces.length === 0) throw new Error('Site info did not include any queryable namespaces');

    const state = {
      version: 1,
      source: this.wiki.baseUrl,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      options,
      namespaces,
      namespaceIndex: 0,
      cursor: null,
      pending: [],
      nextCursor: null,
      batchLoaded: false,
      stage: 'pages',
      counts: { pages: 0, files: 0, categories: 0, revisions: 0 },
    };
    await writeJson(path.join(this.rootDir, 'siteinfo.json'), info);
    await writeJson(stateFile, state);
    return state;
  }

  async #save(state) {
    state.updatedAt = new Date().toISOString();
    await writeJson(path.join(this.rootDir, 'checkpoint.json'), state);
  }

  #recordPath(stage, item) {
    if (stage === 'pages') return path.join(this.rootDir, 'pages', `${item.pageid}.json`);
    if (stage === 'files') return path.join(this.rootDir, 'files', `${fileKey(item.name)}.json`);
    return path.join(this.rootDir, 'categories', `${fileKey(item['*'] ?? item.category ?? JSON.stringify(item))}.json`);
  }

  async #history(page) {
    const target = path.join(this.rootDir, 'history', `${page.pageid}.jsonl`);
    // A prior attempt may have committed history before its checkpoint.
    // Count existing revisions so the resumed manifest remains accurate.
    if (await exists(target)) {
      const lines = readline.createInterface({ input: createReadStream(target), crlfDelay: Infinity });
      let count = 0;
      for await (const line of lines) if (line.trim()) count++;
      return count;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    const handle = await open(temp, 'w');
    let cursor = null;
    let total = 0;
    const seen = new Set();
    try {
      do {
        const result = await this.wiki.listRevisions(page.title, { content: true, limit: 50, cursor });
        for (const revision of result.revisions) {
          await handle.writeFile(`${JSON.stringify(revision)}\n`, 'utf8');
          total++;
        }
        cursor = result.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error('Repeated revision cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (error) {
      await handle.close();
      const { rm } = await import('node:fs/promises');
      await rm(temp, { force: true });
      throw error;
    }
    await handle.close();
    await rename(temp, target);
    return total;
  }

  async #processItem(state) {
    const item = state.pending[0];
    const destination = this.#recordPath(state.stage, item);
    if (!(await exists(destination))) {
      if (state.stage === 'pages') {
        const detail = await this.wiki.getPage(item.title, {
          includeHtml: state.options.includeHtml,
          includeRelations: state.options.includeRelations,
        });
        await writeJson(destination, detail);
      } else {
        await writeJson(destination, item);
      }
    }
    if (state.stage === 'pages' && state.options.includeHistory) {
      const addedRevisions = await this.#history(item);
      state.counts.revisions += addedRevisions;
    }
    state.counts[state.stage]++;
    state.pending.shift();
    await this.#save(state);
  }

  async #loadBatch(state) {
    const previous = state.cursor;
    let data;
    if (state.stage === 'pages') {
      const namespace = state.namespaces[state.namespaceIndex];
      data = await this.wiki.listPages({ namespace, limit: 50, cursor: previous });
      state.pending = data.pages;
    } else if (state.stage === 'files') {
      data = await this.wiki.listFiles({ limit: 50, cursor: previous });
      state.pending = data.files;
    } else {
      data = await this.wiki.listCategories({ limit: 50, cursor: previous });
      state.pending = data.categories;
    }
    if (data.nextCursor && data.nextCursor === previous) {
      throw new Error('The wiki returned a repeated pagination token');
    }
    state.nextCursor = data.nextCursor;
    state.batchLoaded = true;
    await this.#save(state);
  }

  async #advanceBatch(state) {
    if (state.nextCursor) {
      state.cursor = state.nextCursor;
    } else if (state.stage === 'pages') {
      state.namespaceIndex++;
      state.cursor = null;
    } else {
      state.cursor = null;
      state.stage = state.stage === 'files'
        ? (state.options.includeCategories ? 'categories' : 'done')
        : 'done';
    }
    state.nextCursor = null;
    state.batchLoaded = false;
    await this.#save(state);
  }

  async #finalize(state) {
    for (const kind of ['pages', 'files', 'categories']) {
      const dir = path.join(this.rootDir, kind);
      const destination = path.join(this.rootDir, `${kind}.jsonl`);
      await mkdir(dir, { recursive: true });
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
      const temp = `${destination}.${process.pid}.tmp`;
      await writeFile(temp, '', 'utf8');
      for (const file of files) {
        const record = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
        await appendFile(temp, `${JSON.stringify(record)}\n`, 'utf8');
      }
      await rename(temp, destination);
    }
    await writeJson(path.join(this.rootDir, 'manifest.json'), {
      source: state.source,
      startedAt: state.startedAt,
      completedAt: new Date().toISOString(),
      options: state.options,
      namespaces: state.namespaces,
      counts: state.counts,
      files: ['siteinfo.json', 'pages.jsonl', 'files.jsonl', 'categories.jsonl',
        ...(state.options.includeHistory ? ['history/'] : [])],
      note: 'Public content exposed by the MediaWiki API. Binary media is not downloaded. Credit the source and check applicable licenses.',
    });
  }

  async status() {
    const target = path.join(this.rootDir, 'checkpoint.json');
    if (!(await exists(target))) {
      return { started: false, complete: false, outputDir: this.rootDir };
    }
    const state = JSON.parse(await readFile(target, 'utf8'));
    return {
      started: true,
      complete: state.stage === 'done',
      stage: state.stage,
      counts: state.counts,
      options: state.options,
      updatedAt: state.updatedAt,
      namespace: state.stage === 'pages' ? state.namespaces[state.namespaceIndex] ?? null : null,
      outputDir: this.rootDir,
    };
  }

  async batch({ maxItems = 10, ...provided } = {}) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1000) {
      throw new Error('maxItems must be between 1 and 1000');
    }
    const options = { ...DEFAULT_OPTIONS, ...provided };
    if (options.namespace !== null && (!Number.isInteger(options.namespace) || options.namespace < 0)) {
      throw new Error('namespace must be a non-negative integer or null');
    }
    const state = await this.#load(options);
    let processed = 0;
    while (processed < maxItems && state.stage !== 'done') {
      if (state.stage === 'pages' && state.namespaceIndex >= state.namespaces.length) {
        state.stage = options.includeFiles ? 'files' : options.includeCategories ? 'categories' : 'done';
        state.cursor = null;
        state.pending = [];
        state.batchLoaded = false;
        await this.#save(state);
        continue;
      }
      if (!state.batchLoaded) await this.#loadBatch(state);
      if (state.pending.length > 0) {
        await this.#processItem(state);
        processed++;
      } else {
        await this.#advanceBatch(state);
      }
    }
    if (state.stage === 'done' && !(await exists(path.join(this.rootDir, 'manifest.json')))) {
      await this.#finalize(state);
    }
    return {
      complete: state.stage === 'done',
      stage: state.stage,
      processed,
      counts: state.counts,
      namespace: state.stage === 'pages' ? state.namespaces[state.namespaceIndex] ?? null : null,
      outputDir: this.rootDir,
      checkpoint: path.join(this.rootDir, 'checkpoint.json'),
      manifest: state.stage === 'done' ? path.join(this.rootDir, 'manifest.json') : null,
    };
  }
}
