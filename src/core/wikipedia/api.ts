import { LanguageCode, apiEndpoint } from '../security/languages.js';
import { buildArticleUrl, isTrustedImageUrl } from '../security/url.js';
import { ApiErrorKind, ArticleSummary, SearchResult, WikipediaApiError } from './types.js';

/**
 * Client für die MediaWiki Action API (stabile, offiziell dokumentierte
 * Schnittstelle; bewusst kein RESTBase /api/rest_v1/). Alle Antworten werden
 * zur Laufzeit validiert und niemals ungeprüft weiterverwendet.
 *
 * Wikimedia-Policy: Browseranwendungen identifizieren sich über den
 * Api-User-Agent-Header. Keine privaten E-Mail-Adressen im Quellcode.
 */
export const API_USER_AGENT =
  'WikipediaQuickSearch-Extension/1.0 (https://github.com/jpdonie/FDT-Wikipedia-Plugin)';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 100;

interface CacheEntry { value: unknown; expires: number }
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<unknown>>();

function cacheGet(key: string): unknown | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(key: string, value: unknown): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
}

/** Nur für Tests. */
export function clearApiCache(): void {
  cache.clear();
  inFlight.clear();
}

function buildUrl(lang: LanguageCode, params: Record<string, string>): string {
  const url = new URL(apiEndpoint(lang));
  url.search = new URLSearchParams({
    format: 'json',
    formatversion: '2',
    origin: '*',
    ...params
  }).toString();
  return url.toString();
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const cached = cacheGet(url);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(url);
  if (pending) return pending;

  const doFetch = async (): Promise<unknown> => {
    let lastError: WikipediaApiError | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const onOuterAbort = () => controller.abort();
      signal?.addEventListener('abort', onOuterAbort, { once: true });
      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          credentials: 'omit',
          headers: { 'Api-User-Agent': API_USER_AGENT }
        });
        if (response.status === 429) {
          lastError = new WikipediaApiError('ratelimited', 'Rate limit erreicht', 429);
          continue;
        }
        if (!response.ok) {
          const kind: ApiErrorKind = response.status >= 500 ? 'http' : 'not-found';
          lastError = new WikipediaApiError(kind, `HTTP ${response.status}`, response.status);
          if (response.status < 500) break;
          continue;
        }
        const data: unknown = await response.json();
        cacheSet(url, data);
        return data;
      } catch {
        if (signal?.aborted) throw new WikipediaApiError('aborted', 'Anfrage abgebrochen');
        if (controller.signal.aborted) {
          lastError = new WikipediaApiError('timeout', 'Zeitüberschreitung');
          continue;
        }
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        lastError = new WikipediaApiError(offline ? 'offline' : 'http', 'Netzwerkfehler');
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      }
    }
    throw lastError ?? new WikipediaApiError('http', 'Unbekannter Fehler');
  };

  const promise = doFetch().finally(() => inFlight.delete(url));
  inFlight.set(url, promise);
  return promise;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, max = 5000): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

/** Entfernt HTML aus Snippets ohne DOM-Abhängigkeit (Snippets enthalten nur searchmatch-Spans). */
export function stripSnippetHtml(snippet: string): string {
  // Tags wiederholt entfernen, bis sich nichts mehr ändert. Ein einzelner Durchlauf
  // ließe sich über verschachtelte Tags umgehen (z. B. "<scr<script>ipt>" -> "<script>").
  // Danach Entities dekodieren. Das Ergebnis wird ausschließlich als textContent
  // verwendet, nie als innerHTML.
  let text = snippet;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Volltextsuche über die MediaWiki Action API (list=search). */
export async function searchArticles(
  query: string,
  lang: LanguageCode,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const url = buildUrl(lang, {
    action: 'query',
    list: 'search',
    srsearch: query,
    srnamespace: '0',
    srlimit: '8',
    srprop: 'snippet|redirecttitle'
  });
  const data = await fetchJson(url, signal);
  if (!isRecord(data) || !isRecord(data.query) || !Array.isArray(data.query.search)) {
    throw new WikipediaApiError('invalid-response', 'Unerwartetes Antwortformat der Such-API');
  }
  const results: SearchResult[] = [];
  for (const item of data.query.search) {
    if (!isRecord(item)) continue;
    const title = asString(item.title, 500);
    const pageId = typeof item.pageid === 'number' ? item.pageid : undefined;
    if (!title || pageId === undefined) continue;
    results.push({
      title,
      pageId,
      snippet: stripSnippetHtml(asString(item.snippet) ?? ''),
      isRedirect: typeof item.redirecttitle === 'string',
      isDisambiguation: false
    });
  }
  return enrichSearchResults(results, lang, signal);
}

/** Ergänzt Beschreibung, Thumbnail und Begriffsklärungs-Flag (Best Effort). */
async function enrichSearchResults(
  results: SearchResult[],
  lang: LanguageCode,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  if (results.length === 0) return results;
  try {
    const url = buildUrl(lang, {
      action: 'query',
      titles: results.map((r) => r.title).join('|'),
      prop: 'pageprops|description|pageimages',
      ppprop: 'disambiguation',
      piprop: 'thumbnail',
      pithumbsize: '96',
      redirects: '1'
    });
    const data = await fetchJson(url, signal);
    if (!isRecord(data) || !isRecord(data.query) || !Array.isArray(data.query.pages)) return results;
    const byTitle = new Map<string, Record<string, unknown>>();
    for (const page of data.query.pages) {
      if (isRecord(page) && typeof page.title === 'string') byTitle.set(page.title, page);
    }
    // Redirect-Auflösung berücksichtigen
    const redirectMap = new Map<string, string>();
    if (Array.isArray(data.query.redirects)) {
      for (const r of data.query.redirects) {
        if (isRecord(r) && typeof r.from === 'string' && typeof r.to === 'string') {
          redirectMap.set(r.from, r.to);
        }
      }
    }
    return results.map((res) => {
      const resolved = redirectMap.get(res.title) ?? res.title;
      const page = byTitle.get(resolved);
      if (!page) return res;
      const props = isRecord(page.pageprops) ? page.pageprops : {};
      const thumb = isRecord(page.thumbnail) ? asString(page.thumbnail.source, 2000) : undefined;
      return {
        ...res,
        isDisambiguation: 'disambiguation' in props,
        isRedirect: res.isRedirect || resolved !== res.title,
        description: asString(page.description, 500),
        thumbnailUrl: thumb && isTrustedImageUrl(thumb) ? thumb : undefined
      };
    });
  } catch {
    return results; // Anreicherung ist optional; Suchtreffer bleiben gültig.
  }
}

export interface RawSummary {
  title: string;
  description?: string;
  /** NICHT vertrauenswürdiges HTML der Einleitung – muss sanitisiert werden. */
  untrustedIntroHtml: string;
  canonicalUrl: string;
  thumbnailUrl?: string;
  pageImageFile?: string;
  isDisambiguation: boolean;
  redirectedFrom?: string;
  lastModified?: string;
}

/** Lädt Metadaten + Einleitung eines Artikels (prop=extracts|pageimages|info|pageprops). */
export async function getArticleSummaryRaw(
  title: string,
  lang: LanguageCode,
  signal?: AbortSignal
): Promise<RawSummary> {
  const url = buildUrl(lang, {
    action: 'query',
    titles: title,
    prop: 'extracts|pageimages|info|pageprops|description',
    exintro: '1',
    redirects: '1',
    inprop: 'url|touched',
    piprop: 'thumbnail|name',
    pithumbsize: '320',
    ppprop: 'disambiguation'
  });
  const data = await fetchJson(url, signal);
  if (!isRecord(data) || !isRecord(data.query) || !Array.isArray(data.query.pages)) {
    throw new WikipediaApiError('invalid-response', 'Unerwartetes Antwortformat der Artikel-API');
  }
  const page = data.query.pages[0];
  if (!isRecord(page) || page.missing === true || typeof page.title !== 'string') {
    throw new WikipediaApiError('not-found', `Artikel „${title}“ nicht gefunden`);
  }
  let redirectedFrom: string | undefined;
  if (Array.isArray(data.query.redirects)) {
    const r = data.query.redirects[0];
    if (isRecord(r) && typeof r.from === 'string') redirectedFrom = r.from;
  }
  const props = isRecord(page.pageprops) ? page.pageprops : {};
  const thumb = isRecord(page.thumbnail) ? asString(page.thumbnail.source, 2000) : undefined;
  const canonical = asString(page.canonicalurl, 2000) ?? buildArticleUrl(lang, page.title);
  return {
    title: page.title,
    description: asString(page.description, 1000),
    untrustedIntroHtml: asString(page.extract, 200_000) ?? '',
    canonicalUrl: canonical.startsWith(`https://${lang}.wikipedia.org/`) ? canonical : buildArticleUrl(lang, page.title),
    thumbnailUrl: thumb && isTrustedImageUrl(thumb) ? thumb : undefined,
    pageImageFile: asString(page.pageimage, 500),
    isDisambiguation: 'disambiguation' in props,
    redirectedFrom,
    lastModified: asString(page.touched, 100)
  };
}

/** Lädt gerendertes Artikel-HTML über action=parse (NICHT vertrauenswürdig). */
export async function getArticleHtmlRaw(
  title: string,
  lang: LanguageCode,
  signal?: AbortSignal
): Promise<string> {
  const url = buildUrl(lang, {
    action: 'parse',
    page: title,
    prop: 'text',
    redirects: '1',
    disableeditsection: '1',
    disablelimitreport: '1',
    disabletoc: '1'
  });
  const data = await fetchJson(url, signal);
  if (isRecord(data) && isRecord(data.error)) {
    throw new WikipediaApiError('not-found', `Artikel „${title}“ nicht gefunden`);
  }
  if (!isRecord(data) || !isRecord(data.parse) || typeof data.parse.text !== 'string') {
    throw new WikipediaApiError('invalid-response', 'Unerwartetes Antwortformat von action=parse');
  }
  if (data.parse.text.length > 5_000_000) {
    throw new WikipediaApiError('invalid-response', 'Artikel-HTML überschreitet das Größenlimit');
  }
  return data.parse.text;
}

export type { ArticleSummary, SearchResult };
