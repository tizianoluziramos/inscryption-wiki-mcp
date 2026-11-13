import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaDownloadService } from '../src/services/media-download-service.js';

function response(content) {
  return new Response(content, { headers: { 'Content-Type': 'image/png' } });
}

test('downloads a public Fandom asset and resumes without duplication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-media-test-'));
  try {
    await writeFile(path.join(root, 'files.jsonl'), JSON.stringify({
      name: 'Stoat.png', url: 'https://static.wikia.nocookie.net/inscryption/images/s/stoat.png', mime: 'image/png',
    }) + '\n');
    let calls = 0;
    const downloader = new MediaDownloadService(root, {
      fetchImpl: async () => { calls++; return response('image-bytes'); },
      delayMs: 0,
    });
    const initial = await downloader.batch({ maxItems: 1 });
    assert.equal(initial.downloaded, 1);
    const completed = await downloader.batch({ maxItems: 1 });
    assert.equal(completed.completed, true);
    assert.equal(calls, 1);
    const files = (await readdir(path.join(root, 'media'))).filter((name) => name.endsWith('.png'));
    assert.equal(files.length, 1);
    assert.equal(await readFile(path.join(root, 'media', files[0]), 'utf8'), 'image-bytes');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('blocks untrusted media URLs without requesting them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-media-reject-'));
  try {
    await writeFile(path.join(root, 'files.jsonl'), JSON.stringify({
      name: 'danger.png', url: 'https://example.org/anything',
    }) + '\n');
    const downloader = new MediaDownloadService(root, {
      fetchImpl: async () => { throw new Error('must not fetch'); }, delayMs: 0,
    });
    await assert.rejects(downloader.batch({ maxItems: 1 }), /Untrusted media URL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('enforces maximum media file size', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wiki-media-size-'));
  try {
    await writeFile(path.join(root, 'files.jsonl'), JSON.stringify({
      name: 'large.png', url: 'https://static.wikia.nocookie.net/inscryption/images/a.png',
    }) + '\n');
    const downloader = new MediaDownloadService(root, {
      fetchImpl: async () => response('too-large'), delayMs: 0, maxFileBytes: 3,
    });
    await assert.rejects(downloader.batch({ maxItems: 1 }), /max size/);
    const files = await readdir(path.join(root, 'media'));
    assert.equal(files.filter((file) => file.endsWith('.png')).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
