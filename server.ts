import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
import express from 'express';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const GECKO_ANDROID_UA =
  'Mozilla/5.0 (Android 15; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0';
const DESKTOP_GECKO_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 2_400;

// Short-lived in-memory DNS safety cache (prevents redundant lookups, never persisted)
const dnsSafetyCache = new Map<string, { safe: boolean; expiresAt: number }>();

// Ephemeral in-memory search response cache (30s TTL, max 64 entries, zero disk/tracking)
interface SearchResult {
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
}
const searchCache = new Map<string, { results: SearchResult[]; expiresAt: number }>();

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    if (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd')
    ) {
      return true;
    }
    if (normalized.startsWith('::ffff:')) {
      return isPrivateIp(normalized.slice(7));
    }
    return false;
  }

  return true;
}

async function validateExternalUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Unsupported protocol');
  }

  const hostname = parsed.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost')
  ) {
    throw new Error('Blocked destination');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('Blocked destination');
    }
    return parsed;
  }

  const now = Date.now();
  const cached = dnsSafetyCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    if (!cached.safe) throw new Error('Blocked destination');
    return parsed;
  }

  const records = await dns.lookup(hostname, { all: true });
  const safe = records.length > 0 && !records.some((r) => isPrivateIp(r.address));
  if (dnsSafetyCache.size > 500) dnsSafetyCache.clear();
  dnsSafetyCache.set(hostname, { safe, expiresAt: now + 60_000 });

  if (!safe) {
    throw new Error('Blocked destination');
  }

  return parsed;
}

async function safeFetch(
  initialUrl: string,
  options?: {
    accept?: string;
    timeoutMs?: number;
    userAgent?: string;
  }
): Promise<{ response: Response; finalUrl: string }> {
  const acceptHeader =
    options?.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS;
  const userAgent = options?.userAgent ?? GECKO_ANDROID_UA;

  let currentUrl = initialUrl;
  const maxRedirects = 5;

  for (let i = 0; i <= maxRedirects; i++) {
    const validated = await validateExternalUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(validated.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': userAgent,
          Accept: acceptHeader,
          'Accept-Language': 'en-US,en;q=0.9',
          DNT: '1',
          'Sec-GPC': '1',
        },
      });

      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.headers.get('location')
      ) {
        const nextLocation = response.headers.get('location')!;
        currentUrl = new URL(nextLocation, validated).toString();
        continue;
      }

      return { response, finalUrl: validated.toString() };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Too many redirects');
}

async function readBoundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error('Page exceeds size limit');
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
}

function formatDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const pathPart = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${host}${pathPart}`;
  } catch {
    return url;
  }
}

function unwrapDuckDuckGoHref(href: string): string {
  try {
    const u = new URL(href, 'https://lite.duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    return u.toString();
  } catch {
    return href;
  }
}

function unwrapBingTrackingUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.endsWith('bing.com') && parsed.pathname.startsWith('/ck/')) {
      const uParam = parsed.searchParams.get('u');
      if (uParam && uParam.startsWith('a1')) {
        const decoded = Buffer.from(uParam.slice(2), 'base64url').toString('utf8');
        if (decoded.startsWith('http://') || decoded.startsWith('https://')) {
          return decoded;
        }
      }
    }
  } catch {
    // Fallback to rawUrl
  }
  return rawUrl;
}

async function searchDuckDuckGoLite(query: string): Promise<SearchResult[]> {
  const endpoint = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const { response } = await safeFetch(endpoint, { timeoutMs: SEARCH_TIMEOUT_MS });
  if (response.status !== 200) {
    throw new Error(`DDG Lite status ${response.status}`);
  }

  const html = await readBoundedText(response);
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $('a.result-link').each((_, el) => {
    const rawHref = $(el).attr('href');
    const title = $(el).text().trim();
    if (!rawHref || !title) return;

    const url = unwrapDuckDuckGoHref(rawHref);
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    const row = $(el).closest('tr');
    const snippet = row.nextAll('tr').find('.result-snippet').first().text().trim();

    results.push({
      title,
      url,
      displayUrl: formatDisplayUrl(url),
      snippet,
    });
  });

  if (results.length === 0) {
    throw new Error('DDG Lite returned zero results');
  }

  return results.slice(0, 12);
}

async function searchBingClean(query: string): Promise<SearchResult[]> {
  const endpoint = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en`;
  const { response } = await safeFetch(endpoint, {
    timeoutMs: SEARCH_TIMEOUT_MS,
    userAgent: DESKTOP_GECKO_UA,
  });
  if (!response.ok) {
    throw new Error(`Bing status ${response.status}`);
  }

  const html = await readBoundedText(response);
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $('li.b_algo').each((_, el) => {
    const link = $(el).find('h2 a').first();
    const rawHref = link.attr('href');
    const title = link.text().trim();
    if (!rawHref || !title) return;

    const url = unwrapBingTrackingUrl(rawHref);
    if (!url.startsWith('http://') && !url.startsWith('https://')) return;

    const snippet = $(el)
      .find('.b_caption p, .b_lineclamp2, .b_algoSlug')
      .first()
      .text()
      .trim();

    results.push({
      title,
      url,
      displayUrl: formatDisplayUrl(url),
      snippet,
    });
  });

  if (results.length === 0) {
    throw new Error('Bing returned zero results');
  }

  return results.slice(0, 12);
}

async function searchWikipediaFast(query: string): Promise<SearchResult[]> {
  const endpoint = `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=10&srsearch=${encodeURIComponent(query)}`;
  const { response } = await safeFetch(endpoint, {
    accept: 'application/json',
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  if (!response.ok) {
    throw new Error(`Wikipedia status ${response.status}`);
  }

  const data = (await response.json()) as {
    query?: { search?: Array<{ title: string; snippet: string }> };
  };
  const items = data.query?.search ?? [];
  if (items.length === 0) {
    throw new Error('Wikipedia returned zero results');
  }

  return items.map((item) => {
    const slug = encodeURIComponent(item.title.replace(/ /g, '_'));
    const url = `https://en.wikipedia.org/wiki/${slug}`;
    const cleanSnippet = cheerio.load(item.snippet).text().trim();
    return {
      title: item.title,
      url,
      displayUrl: `en.wikipedia.org/wiki/${item.title.replace(/ /g, '_')}`,
      snippet: cleanSnippet,
    };
  });
}

async function runFastSearch(query: string): Promise<SearchResult[]> {
  const key = query.toLowerCase();
  const now = Date.now();
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.results;
  }

  // Race full-web providers first (DDG Lite + Bing clean), with Wikipedia racing alongside
  const ddgPromise = searchDuckDuckGoLite(query);
  const bingPromise = searchBingClean(query);
  const wikiPromise = searchWikipediaFast(query);

  let results: SearchResult[] = [];
  try {
    // Return the fastest full-web provider as soon as either succeeds
    results = await Promise.any([ddgPromise, bingPromise]);
  } catch {
    try {
      results = await wikiPromise;
    } catch {
      results = [];
    }
  }

  if (results.length > 0) {
    if (searchCache.size >= 64) {
      const oldestKey = searchCache.keys().next().value;
      if (oldestKey) searchCache.delete(oldestKey);
    }
    searchCache.set(key, { results, expiresAt: now + 30_000 });
  }

  return results;
}

function sanitizeAndRewriteHtml(rawHtml: string, baseUrl: string): string {
  const $ = cheerio.load(rawHtml);

  $(
    'script, noscript, iframe, object, embed, meta[http-equiv="Content-Security-Policy"], meta[http-equiv="refresh"]'
  ).remove();

  $('*').each((_, node) => {
    if (node.type !== 'tag') return;
    const attribs = node.attribs || {};
    for (const attr of Object.keys(attribs)) {
      if (attr.toLowerCase().startsWith('on')) {
        $(node).removeAttr(attr);
      }
    }
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.trim().toLowerCase().startsWith('javascript:')) {
      $(el).attr('href', '#');
      return;
    }
    try {
      const resolved = new URL(href, baseUrl).toString();
      $(el).attr('href', resolved);
      $(el).attr('rel', 'noreferrer noopener');
      $(el).removeAttr('target');
    } catch {
      // Leave hash or relative anchor intact
    }
  });

  $('img[src], source[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    try {
      $(el).attr('src', new URL(src, baseUrl).toString());
      $(el).attr('referrerpolicy', 'no-referrer');
    } catch {
      // Ignore malformed src
    }
  });

  $('link[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      $(el).attr('href', new URL(href, baseUrl).toString());
    } catch {
      // Ignore
    }
  });

  if ($('head').length === 0) {
    $.root().prepend('<head></head>');
  }

  $('head base').remove();
  $('head').prepend(`<base href="${baseUrl.replace(/"/g, '&quot;')}">`);
  $('head').append(
    '<meta name="referrer" content="no-referrer"><style>html{color-scheme:light dark;}body{max-width:100%;overflow-x:hidden;padding-bottom:84px;}</style>'
  );

  return $.html();
}

async function startServer() {
  const app = express();
  app.disable('x-powered-by');

  app.use((_, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/search', async (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query) {
      res.status(400).json({ error: 'Empty query' });
      return;
    }

    try {
      const results = await runFastSearch(query);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ query, results });
    } catch {
      res.status(502).json({ error: 'Search unavailable right now' });
    }
  });

  app.get('/api/page', async (req, res) => {
    const target = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!target) {
      res.status(400).type('text/plain').send('Missing URL');
      return;
    }

    try {
      const { response, finalUrl } = await safeFetch(target);
      const contentType = response.headers.get('content-type') || 'text/html';

      if (!response.ok) {
        res
          .status(response.status)
          .type('text/html')
          .send(
            `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:48px 24px;max-width:600px;margin:0 auto;color:#52525b;">` +
              `<p style="font-size:15px;">Could not load ${finalUrl.replace(/</g, '&lt;')} (HTTP ${response.status}).</p>` +
              `</body></html>`
          );
        return;
      }

      if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
        const rawHtml = await readBoundedText(response);
        const cleanHtml = sanitizeAndRewriteHtml(rawHtml, finalUrl);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Final-Url', finalUrl);
        res.type('text/html; charset=utf-8').send(cleanHtml);
        return;
      }

      if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) {
        const text = await readBoundedText(response);
        res.setHeader('Cache-Control', 'no-store');
        res.type('text/plain; charset=utf-8').send(text);
        return;
      }

      const arrayBuf = await response.arrayBuffer();
      if (arrayBuf.byteLength > MAX_BODY_BYTES) {
        res.status(413).type('text/plain').send('File too large');
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      res.type(contentType).send(Buffer.from(arrayBuf));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load page';
      res
        .status(502)
        .type('text/html')
        .send(
          `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:48px 24px;max-width:600px;margin:0 auto;color:#52525b;">` +
            `<p style="font-size:15px;">${message.replace(/</g, '&lt;')}</p>` +
            `</body></html>`
        );
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`nothing listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
