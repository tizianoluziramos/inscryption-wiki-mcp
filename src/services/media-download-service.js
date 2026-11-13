import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const EXTENSIONS = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'],
  ['image/webp', '.webp'], ['image/svg+xml', '.svg'], ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'], ['audio/wav', '.wav'], ['video/webm', '.webm'],
  ['video/mp4', '.mp4'], ['application/pdf', '.pdf'],
]);

function trustedMediaUrl(raw) {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  const allowed = host === 'static.wikia.nocookie.net'
    || host.endsWith('.wikia.nocookie.net')
    || host === 'images.wikia.com';
  if (url.protocol !== 'https:' || !allowed || url.username || url.password) {
    throw new Error(`Untrusted media URL host: ${host}`);
  }
  return url;
}

function safeExtension(item) {
  const fromName = path.extname(item.name ?? '').toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXTENSIONS.get(String(item.mime ?? '').toLowerCase()) ?? '.bin';
}

function fileName(item) {
  const key = createHash('sha256').update(item.name ?? item.url).digest('hex');
  return `${key}${safeExtension(item)}`;
}

async function exists(file) {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function* mediaRecords(file) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) yield JSON.parse(line);
  }
}

export class MediaDownloadService {
  constructor(rootDir, {
    fetchImpl = globalThis.fetch,
    wait = sleep,
    delayMs = 1000,
    timeoutMs = 30000,
    maxFileBytes = 20 * 1024 * 1024,
    maxRetries = 2,
    userAgent = 'InscryptionWikiMCP/1.0 (public-asset-reader)',
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.fetchImpl = fetchImpl;
    this.wait = wait;
    this.delayMs = delayMs;
    this.timeoutMs = timeoutMs;
    this.maxFileBytes = maxFileBytes;
    this.maxRetries = maxRetries;
    this.userAgent = userAgent;
  }

  async #fetchAllowed(raw, signal) {
    let url = trustedMediaUrl(raw);
    for (let hop = 0; hop <= 3; hop++) {
      const response = await this.fetchImpl(url, {
        method: 'GET', redirect: 'manual', signal,
        headers: { 'User-Agent': this.userAgent },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Media redirect missing Location header');
        url = trustedMediaUrl(new URL(location, url).href);
        await response.body?.cancel();
        continue;
      }
      return response;
    }
    throw new Error('Too many media redirects');
  }

  async #download(item, destination) {
    if (!item.url) throw new Error(`Missing public URL for ${item.name}`);
    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.#fetchAllowed(item.url, controller.signal);
        if (!response.ok) {
          lastError = new Error(`Media request for ${item.name} returned HTTP ${response.status}`);
          if (!TRANSIENT_STATUSES.has(response.status) || attempt === this.maxRetries) throw lastError;
          const retryAfter = Number(response.headers.get('retry-after'));
          await response.body?.cancel();
          const retryMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(120000, retryAfter * 1000)
            : 1000 * (2 ** attempt);
          // Do not retain the timeout while observing server-requested backoff.
          clearTimeout(timeout);
          await this.wait(retryMs);
          continue;
        }
        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > this.maxFileBytes) {
          await response.body?.cancel();
          throw new Error(`Media exceeds max size (${this.maxFileBytes} bytes): ${item.name}`);
        }
        if (!response.body) throw new Error(`Media returned no body: ${item.name}`);
        const temp = `${destination}.${process.pid}.tmp`;
        const handle = await open(temp, 'w');
        let size = 0;
        try {
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > this.maxFileBytes) throw new Error(`Media exceeds max size: ${item.name}`);
            await handle.writeFile(chunk);
          }
          await handle.close();
          await rename(temp, destination);
          return size;
        } catch (error) {
          await handle.close().catch(() => {});
          await rm(temp, { force: true });
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error(`Cannot download ${item.name}`);
  }

  async status() {
    const checkpoint = path.join(this.rootDir, 'media', 'checkpoint.json');
    if (!(await exists(checkpoint))) {
      return { started: false, completed: false, outputDir: path.join(this.rootDir, 'media') };
    }
    return { started: true, ...JSON.parse(await readFile(checkpoint, 'utf8')),
      outputDir: path.join(this.rootDir, 'media') };
  }

  async batch({ maxItems = 10 } = {}) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 50) {
      throw new Error('maxItems must be an integer from 1 to 50');
    }
    const listFile = path.join(this.rootDir, 'files.jsonl');
    if (!(await exists(listFile))) {
      throw new Error('Run export:wiki to completion before downloading media');
    }
    const dir = path.join(this.rootDir, 'media');
    const checkpoint = path.join(dir, 'checkpoint.json');
    await mkdir(dir, { recursive: true });
    const state = await exists(checkpoint)
      ? JSON.parse(await readFile(checkpoint, 'utf8'))
      : { version: 1, nextIndex: 0, downloaded: 0, alreadyPresent: 0, completed: false };
    if (state.version !== 1) throw new Error('Incompatible media checkpoint');
    let processed = 0;
    let index = 0;
    for await (const item of mediaRecords(listFile)) {
      if (index++ < state.nextIndex) continue;
      if (processed >= maxItems) break;
      const localName = fileName(item);
      const destination = path.join(dir, localName);
      if (await exists(destination)) {
        state.alreadyPresent++;
      } else {
        await this.#download(item, destination);
        state.downloaded++;
        if (this.delayMs) await this.wait(this.delayMs);
      }
      const infoDir = path.join(dir, 'index');
      await mkdir(infoDir, { recursive: true });
      await writeFile(path.join(infoDir, `${localName}.json`), JSON.stringify({
        name: item.name, url: item.url, mime: item.mime ?? null,
        localName, size: (await stat(destination)).size,
      }, null, 2) + '\n');
      state.nextIndex++;
      processed++;
      await writeFile(checkpoint, JSON.stringify(state, null, 2) + '\n');
    }
    if (processed < maxItems) {
      state.completed = true;
      await writeFile(checkpoint, JSON.stringify(state, null, 2) + '\n');
    }
    return { ...state, processed, outputDir: dir };
  }
}
