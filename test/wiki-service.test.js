import test from 'node:test';
import assert from 'node:assert/strict';
import { WikiService } from '../src/services/wiki-service.js';

class FakeClient {
  requests = [];
  constructor(responses) { this.responses = responses; }
  async request(parameters) {
    this.requests.push(parameters);
    const result = this.responses.shift();
    if (!result) throw new Error('Unexpected API request');
    return result;
  }
}

test('getPage exports full content and merges paginated relationships', async () => {
  const client = new FakeClient([
    { query: { pages: [{ title: 'Stoat', ns: 0, pageid: 7, revisions: [
      { revid: 22, timestamp: '2026-01-01', slots: { main: { content: '{{Card|name=Stoat}}' } } },
    ] }] } },
    { query: { pages: [{ title: 'Stoat', pageid: 7, categories: [{ title: 'Category:Cards' }] } ] },
      continue: { continue: '||', clcontinue: '7|Cards 2' } },
    { query: { pages: [{ title: 'Stoat', pageid: 7, images: [{ title: 'File:Stoat.png' }] }] } },
  ]);
  const wiki = new WikiService(client);
  const result = await wiki.getPage('Stoat');
  assert.equal(result.pageid, 7);
  assert.equal(result.wikitext, '{{Card|name=Stoat}}');
  assert.equal(result.relations.categories[0].title, 'Category:Cards');
  assert.equal(result.relations.images[0].title, 'File:Stoat.png');
  assert.equal(client.requests[2].clcontinue, '7|Cards 2');
});

test('listPages returns cursor and URL', async () => {
  const client = new FakeClient([{
    query: { allpages: [{ pageid: 10, title: 'Cards', ns: 0 }] },
    continue: { continue: '-||', apcontinue: 'Cards 2' },
  }]);
  const wiki = new WikiService(client);
  const result = await wiki.listPages();
  assert.equal(result.pages[0].url, 'https://inscryption.fandom.com/wiki/Cards');
  assert.ok(result.nextCursor);
});
