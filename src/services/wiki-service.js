import { decodeCursor, encodeCursor } from '../utils/cursor.js';

function requiredTitle(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw new Error('A valid page title is required');
  }
  return value.trim().replaceAll('_', ' ');
}

function pageFromResponse(result) {
  const pages = result.query?.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('MediaWiki did not return a page');
  }
  const page = pages[0];
  if (page.missing) throw new Error(`Page does not exist: ${page.title}`);
  return page;
}

function wikitextFromRevision(revision) {
  if (!revision) return null;
  const main = revision.slots?.main;
  return main?.content ?? main?.['*'] ?? revision.content ?? revision['*'] ?? null;
}

export class WikiService {
  constructor(client, baseUrl = 'https://inscryption.fandom.com') {
    this.client = client;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  pageUrl(title) {
    return `${this.baseUrl}/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
  }

  async info() {
    const result = await this.client.request({
      meta: 'siteinfo',
      siprop: 'general|namespaces|namespacealiases|statistics|rightsinfo',
    });
    return { ...result.query, source: this.baseUrl };
  }

  async search(query, { limit = 20, cursor = null } = {}) {
    const result = await this.client.request({
      list: 'search',
      srsearch: query,
      srlimit: limit,
      srprop: 'timestamp|snippet|wordcount|size',
      ...decodeCursor(cursor),
    });
    return {
      total: result.query?.searchinfo?.totalhits ?? null,
      results: (result.query?.search ?? []).map((entry) => ({ ...entry, url: this.pageUrl(entry.title) })),
      nextCursor: encodeCursor(result.continue),
    };
  }

  async listPages({ namespace = 0, limit = 50, cursor = null, redirects = true } = {}) {
    const result = await this.client.request({
      list: 'allpages', apnamespace: namespace, aplimit: limit,
      ...(redirects ? {} : { apfilterredir: 'nonredirects' }),
      ...decodeCursor(cursor),
    });
    return {
      pages: (result.query?.allpages ?? []).map((entry) => ({ ...entry, url: this.pageUrl(entry.title) })),
      nextCursor: encodeCursor(result.continue),
    };
  }

  async listCategories({ limit = 50, cursor = null } = {}) {
    const result = await this.client.request({ list: 'allcategories', aclimit: limit, ...decodeCursor(cursor) });
    return { categories: result.query?.allcategories ?? [], nextCursor: encodeCursor(result.continue) };
  }

  async categoryMembers(category, { limit = 50, cursor = null, type = 'all' } = {}) {
    const title = requiredTitle(category);
    const result = await this.client.request({
      list: 'categorymembers', cmtitle: title.startsWith('Category:') ? title : `Category:${title}`,
      cmlimit: limit, ...(type === 'all' ? {} : { cmtype: type }), ...decodeCursor(cursor),
    });
    return {
      members: (result.query?.categorymembers ?? []).map((entry) => ({ ...entry, url: this.pageUrl(entry.title) })),
      nextCursor: encodeCursor(result.continue),
    };
  }

  async listFiles({ limit = 50, cursor = null } = {}) {
    const result = await this.client.request({
      list: 'allimages', ailimit: limit, aiprop: 'timestamp|user|size|dimensions|url|mime|sha1',
      ...decodeCursor(cursor),
    });
    return { files: result.query?.allimages ?? [], nextCursor: encodeCursor(result.continue) };
  }

  async fileInfo(title) {
    const normalized = requiredTitle(title);
    const result = await this.client.request({
      prop: 'info|imageinfo', inprop: 'url',
      titles: normalized.startsWith('File:') ? normalized : `File:${normalized}`,
      iiprop: 'url|size|mime|sha1|timestamp|user|extmetadata', iilimit: 1,
    });
    const page = pageFromResponse(result);
    return { ...page, sourceUrl: this.pageUrl(page.title) };
  }

  async backlinks(title, { limit = 50, cursor = null } = {}) {
    const result = await this.client.request({
      list: 'backlinks', bltitle: requiredTitle(title), bllimit: limit, ...decodeCursor(cursor),
    });
    return {
      pages: (result.query?.backlinks ?? []).map((entry) => ({ ...entry, url: this.pageUrl(entry.title) })),
      nextCursor: encodeCursor(result.continue),
    };
  }

  async listRevisions(title, { limit = 50, cursor = null, content = false } = {}) {
    const result = await this.client.request({
      prop: 'revisions', titles: requiredTitle(title), rvlimit: limit,
      rvprop: `ids|timestamp|user|comment|flags${content ? '|content' : ''}`,
      ...(content ? { rvslots: 'main' } : {}),
      ...decodeCursor(cursor),
    });
    const page = pageFromResponse(result);
    return {
      title: page.title,
      revisions: (page.revisions ?? []).map((revision) => content
        ? { ...revision, wikitext: wikitextFromRevision(revision) }
        : revision),
      nextCursor: encodeCursor(result.continue),
    };
  }

  async getRevision(revisionId) {
    const result = await this.client.request({
      prop: 'revisions', revids: revisionId,
      rvprop: 'ids|timestamp|user|comment|flags|content', rvslots: 'main',
    });
    const page = pageFromResponse(result);
    const revision = page.revisions?.[0];
    if (!revision) throw new Error(`Revision does not exist: ${revisionId}`);
    return { title: page.title, sourceUrl: this.pageUrl(page.title), ...revision, wikitext: wikitextFromRevision(revision) };
  }

  async parsedPage(title) {
    const result = await this.client.request({
      action: 'parse', page: requiredTitle(title),
      prop: 'text|sections|displaytitle|properties',
      disabletoc: 1,
    });
    const parsed = result.parse;
    if (!parsed) throw new Error(`Cannot parse page: ${title}`);
    return {
      title: parsed.title,
      pageid: parsed.pageid,
      html: typeof parsed.text === 'string' ? parsed.text : parsed.text?.['*'] ?? null,
      sections: parsed.sections ?? [],
      displaytitle: parsed.displaytitle ?? null,
      properties: parsed.properties ?? [],
    };
  }

  async getPage(title, { includeWikitext = true, includeRelations = true, includeHtml = false } = {}) {
    const normalized = requiredTitle(title);
    const result = await this.client.request({
      prop: includeWikitext ? 'info|revisions|pageprops' : 'info|pageprops',
      titles: normalized,
      inprop: 'url|displaytitle',
      ...(includeWikitext ? { rvprop: 'ids|timestamp|user|comment|content|contentmodel', rvslots: 'main', rvlimit: 1 } : {}),
    });
    const page = pageFromResponse(result);
    const revision = page.revisions?.[0];
    const output = {
      sourceUrl: page.fullurl ?? this.pageUrl(page.title),
      pageid: page.pageid,
      ns: page.ns,
      title: page.title,
      touched: page.touched ?? null,
      lastrevid: page.lastrevid ?? null,
      length: page.length ?? null,
      contentmodel: page.contentmodel ?? null,
      redirect: Boolean(page.redirect),
      pageprops: page.pageprops ?? {},
    };
    if (includeWikitext) {
      output.revision = revision ? {
        revid: revision.revid,
        timestamp: revision.timestamp,
        user: revision.user ?? null,
        comment: revision.comment ?? '',
        contentmodel: revision.slots?.main?.contentmodel ?? revision.contentmodel ?? null,
      } : null;
      output.wikitext = wikitextFromRevision(revision);
    }
    if (includeRelations) output.relations = await this.#relations(normalized);
    if (includeHtml) output.parsed = await this.parsedPage(normalized);
    return output;
  }

  async #relations(title) {
    const fields = ['categories', 'templates', 'images', 'links', 'extlinks'];
    const result = Object.fromEntries(fields.map((key) => [key, []]));
    let cursor = null;
    const visited = new Set();
    do {
      const response = await this.client.request({
        prop: 'categories|templates|images|links|extlinks',
        titles: title, cllimit: 50, tllimit: 50, imlimit: 50, pllimit: 50, ellimit: 50,
        ...decodeCursor(cursor),
      });
      const page = pageFromResponse(response);
      for (const field of fields) result[field].push(...(page[field] ?? []));
      cursor = encodeCursor(response.continue);
      if (cursor && visited.has(cursor)) throw new Error('Repeated MediaWiki continuation token');
      if (cursor) visited.add(cursor);
    } while (cursor);
    return result;
  }
}
