import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaWikiClient, MediaWikiError } from '../src/api/mediawiki-client.js';

function createClient(fetchImpl, options = {}) {
  return new MediaWikiClient({
    apiUrl: 'https://inscryption.fandom.com/api.php',
    userAgent: 'unit-test-agent',
    minDelayMs: 0,
    maxRetries: 0,
    fetchImpl,
    wait: async () => {},
    ...options,
  });
}

const json = (body, init = {}) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json', ...init.headers },
  status: init.status ?? 200,
});

test('builds read-only Action API requests with MediaWiki defaults', async () => {
  const client = createClient(async (url, options) => {
    assert.equal(url.searchParams.get('action'), 'query');
    assert.equal(url.searchParams.get('formatversion'), '2');
    assert.equal(url.searchParams.get('titles'), 'Stoat');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['User-Agent'], 'unit-test-agent');
    return json({ query: { pages: [{ title: 'Stoat' }] } });
  });
  const result = await client.request({ titles: 'Stoat' });
  assert.equal(result.query.pages[0].title, 'Stoat');
});

test('honors HTTP Retry-After when rate limited', async () => {
  const delays = [];
  let requests = 0;
  const client = createClient(async () => {
    requests++;
    return requests === 1
      ? json({}, { status: 429, headers: { 'Retry-After': '2' } })
      : json({ query: { ok: true } });
  }, { maxRetries: 1, wait: async (delay) => { delays.push(delay); } });
  assert.deepEqual((await client.request({})).query, { ok: true });
  assert.equal(requests, 2);
  assert.ok(delays.some((delay) => delay === 2000));
});

test('reports access denial without bypassing blocks', async () => {
  const client = createClient(async () => json({}, { status: 403 }));
  await assert.rejects(client.request({}), (error) => {
    assert.ok(error instanceof MediaWikiError);
    assert.equal(error.status, 403);
    assert.match(error.message, /will not bypass/);
    return true;
  });
});

test('queue remains usable after a failed call', async () => {
  let calls = 0;
  const client = createClient(async () => {
    calls++;
    if (calls === 1) return json({ error: { code: 'missingtitle', info: 'No title' } });
    return json({ query: { ok: true } });
  });
  await assert.rejects(client.request({}), /missingtitle/);
  assert.deepEqual((await client.request({})).query, { ok: true });
});
