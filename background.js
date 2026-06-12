// background.js — GPL v27
'use strict';

chrome.action.onClicked.addListener((tab) => { chrome.sidePanel.open({ tabId: tab.id }); });
chrome.runtime.onInstalled.addListener(() => { chrome.sidePanel.setOptions({ enabled: true }); });

const CACHE_TTL       = 12 * 60 * 60 * 1000; // 12h full rebuild
const INCREMENTAL_TTL =  2 * 60 * 1000;       // 2min incremental (v27: faster)
const CACHE_KEY  = 'oleNotionCache';
const SCHEMA_KEY = 'oleNotionSchema';

let _pages = {}, _fetchedAt = null, _incrementalAt = null;
let _schemaTypes = {}, _cacheLoaded = false, _buildInProgress = false;
let _schemaRelations = {};   // relation prop name -> related database id
const _relDbSchemas = {};    // related database id -> { propName: type }

// ── STORAGE ───────────────────────────────────────────────────────────────────
async function loadCacheFromStorage() {
  if (_cacheLoaded) return;
  try {
    const s = await chrome.storage.local.get([CACHE_KEY, SCHEMA_KEY]);
    if (s[CACHE_KEY]) {
      _pages        = s[CACHE_KEY].pages        || {};
      _fetchedAt    = s[CACHE_KEY].fetchedAt    || null;
      _incrementalAt= s[CACHE_KEY].incrementalAt|| null;
    }
    if (s[SCHEMA_KEY]) {
      const sc = s[SCHEMA_KEY];
      if (sc.types) { _schemaTypes = sc.types || {}; _schemaRelations = sc.relations || {}; }
      else _schemaTypes = sc || {};   // legacy shape
    }
    _cacheLoaded = true;
    console.log(`[GPL bg] Cache loaded: ${Object.keys(_pages).length} keys, fetched=${_fetchedAt ? new Date(_fetchedAt).toISOString() : 'never'}`);
  } catch(e) { _cacheLoaded = true; }
}
async function saveCacheToStorage() {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { pages:_pages, fetchedAt:_fetchedAt, incrementalAt:_incrementalAt }
    });
  } catch(e) { console.warn('[GPL bg] save failed:', e.message); }
}
async function saveSchemaToStorage() {
  try { await chrome.storage.local.set({ [SCHEMA_KEY]: { types:_schemaTypes, relations:_schemaRelations } }); } catch {}
}
function cacheIsValid()       { return !!_fetchedAt && (Date.now() - _fetchedAt    < CACHE_TTL); }
function incrementalSyncDue() { return !_incrementalAt || (Date.now() - _incrementalAt > INCREMENTAL_TTL); }

// ── RATE-LIMIT FETCH ──────────────────────────────────────────────────────────
async function notionFetchHttp(url, options, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.status === 429) {
      if (attempt === retries) throw new Error('Notion rate limited. Wait and retry.');
      await new Promise(r => setTimeout(r, Math.pow(2, attempt + 1) * 1000));
      continue;
    }
    return res;
  }
}

function notionHeaders(apiKey) {
  return { 'Authorization':`Bearer ${apiKey}`, 'Content-Type':'application/json', 'Notion-Version':'2022-06-28' };
}

// ── PROP TEXT — handles ALL Notion property types ─────────────────────────────
function getPropText(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'formula':
      if (prop.formula?.type === 'string') return prop.formula.string || '';
      if (prop.formula?.type === 'number') return String(prop.formula.number ?? '');
      return String(prop.formula?.string || prop.formula?.number || '');
    case 'url':       return prop.url || '';
    // rich_text/title: ALSO read each segment's href — a URL pasted as a
    // hyperlink ("Doc" → link) has the real URL only in href, not plain_text
    case 'rich_text': return (prop.rich_text || []).map(t => [t.plain_text || '', t.href || ''].filter(Boolean).join(' ')).join(' ');
    case 'title':     return (prop.title     || []).map(t => [t.plain_text || '', t.href || ''].filter(Boolean).join(' ')).join(' ');
    case 'select':    return prop.select?.name || '';
    case 'status':    return prop.status?.name || '';
    case 'number':    return String(prop.number ?? '');
    case 'email':     return prop.email || '';
    case 'phone_number': return prop.phone_number || '';
    case 'files':
      return (prop.files || []).map(f => f.external?.url || f.file?.url || '').filter(Boolean).join(' ');
    case 'rollup':
      if (prop.rollup?.type === 'array')  return (prop.rollup.array || []).map(getPropText).join(' ');
      if (prop.rollup?.type === 'number') return String(prop.rollup.number ?? '');
      return '';
    default: return '';
  }
}

// ── DOC ID EXTRACTION — tries every possible format ───────────────────────────
function extractDocFileId(url) {
  if (!url || typeof url !== 'string') return null;
  // /d/FILE_ID  (docs.google.com/document/d/...)
  const m1 = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m1) return m1[1];
  // ?id=FILE_ID or &id=FILE_ID  (google.com/open?id=... or drive links)
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m2) return m2[1];
  // /file/d/FILE_ID  (drive.google.com/file/d/...)
  const m3 = url.match(/\/file\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m3) return m3[1];
  // Bare ID (25+ chars, no slashes)
  const m4 = url.match(/^([a-zA-Z0-9_-]{25,})$/);
  if (m4) return m4[1];
  return null;
}

// Find a Google-Doc-shaped id token anywhere in arbitrary text (formula output
// that is a bare id or id with surrounding words). Conservative: requires a
// hyphen/underscore or length ≥ 30 so it does not grab random alphanumerics.
function looseGoogleDocId(text) {
  if (!text || typeof text !== 'string') return null;
  const direct = extractDocFileId(text);
  if (direct) return direct;
  const tokens = text.match(/[a-zA-Z0-9_-]{25,}/g) || [];
  for (const t of tokens) {
    if (t.length >= 30 || /[-_]/.test(t)) return t;
  }
  return null;
}

// Normalise google.com/open?id= and drive links to canonical docs URL
function normaliseDocUrl(url) {
  if (!url) return url;
  const id = extractDocFileId(url);
  if (!id) return url;
  // Only normalise non-standard formats
  if (url.includes('docs.google.com/document/d/')) return url;
  return 'https://docs.google.com/document/d/' + id + '/edit';
}

// ── ALL INDEXABLE KEYS FOR A DOC URL ──────────────────────────────────────────
// v27: Also index google.com/open?id= and drive.google.com URLs
function allDocKeys(docUrl) {
  if (!docUrl || typeof docUrl !== 'string') return [];
  const keys = new Set();
  // Normalise before indexing so open?id= format hits the same key as /d/ format
  const normalised = normaliseDocUrl(docUrl.trim());
  const trimmed = normalised || docUrl.trim();

  // 1. The file ID itself
  const fileId = extractDocFileId(trimmed);
  if (fileId) keys.add(fileId);

  // 2. URL without query string
  try {
    const u = new URL(trimmed);
    keys.add(u.origin + u.pathname);                      // https://docs.google.com/document/d/ID/edit
    const pathParts = u.pathname.split('/');
    const dIdx = pathParts.indexOf('d');
    if (dIdx !== -1 && pathParts[dIdx + 1]) {
      keys.add(pathParts[dIdx + 1]);                      // just the ID segment
    }
  } catch {}

  // 3. Lowercase variants
  const lower = trimmed.toLowerCase();
  const fileIdLower = extractDocFileId(lower);
  if (fileIdLower) keys.add(fileIdLower);

  return [...keys].filter(k => k && k.length >= 10);
}

// ── LOOK UP A DOC IN CACHE ────────────────────────────────────────────────────
function lookupDoc(docUrl) {
  if (!docUrl) return null;
  const keys = allDocKeys(docUrl);
  for (const k of keys) {
    if (_pages[k]) {
      console.log(`[GPL bg] Cache hit: key="${k}"`);
      return _pages[k];
    }
  }
  return null;
}

// ── BUILD A SINGLE PAGE ENTRY ─────────────────────────────────────────────────
const DOC_IN_JSON_RX = /(?:docs\.google\.com\/document\/d\/|\/file\/d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/;

// overrideDocUrl: doc URL resolved externally (e.g. from a related page) when
// the page's own properties don't expose it.
function pageEntryFromNotion(page, config, overrideDocUrl) {
  const props = page.properties || {};

  // Try the configured Final Doc property name first
  let finalDocValue = '';
  const finalDocProp = props[config.propFinalDoc];
  if (finalDocProp) {
    finalDocValue = getPropText(finalDocProp);
  }

  // Fallback: search ALL properties for a Google DOC/Drive-file URL.
  // Match the id from an explicit document context — a bare /d/ pattern would
  // also swallow Client Sheet spreadsheet URLs and mis-index the page.
  if (!finalDocValue || !extractDocFileId(finalDocValue)) {
    for (const [propName, propVal] of Object.entries(props)) {
      const val = getPropText(propVal);
      if (!val) continue;
      const dm = val.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/i)
            || val.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([a-zA-Z0-9_-]{20,})/i)
            || val.match(/(?:^|[^.\w])google\.com\/open\?id=([a-zA-Z0-9_-]{20,})/i);
      if (dm) {
        finalDocValue = 'https://docs.google.com/document/d/' + dm[1] + '/edit';
        console.log(`[GPL bg] Found doc URL in prop "${propName}": ${val.slice(0,60)}`);
        break;
      }
    }
  }

  // Last resort: a formula may output a BARE id ("1xm-ZEHsDN6…") or an id with
  // surrounding text ("Doc: 1xm…") that the URL patterns above miss. Scan every
  // property's text for a Google-Doc-shaped id token and rebuild a canonical URL.
  // Skip values that are clearly OTHER Google products (sheets/forms/slides).
  if (!finalDocValue || !extractDocFileId(finalDocValue)) {
    for (const propVal of Object.values(props)) {
      const val = getPropText(propVal);
      if (!val || /docs\.google\.com\/(?:spreadsheets|forms|presentation)/i.test(val)) continue;
      const id = looseGoogleDocId(val);
      if (id) { finalDocValue = 'https://docs.google.com/document/d/' + id + '/edit'; break; }
    }
  }

  // Absolute last resort: scan the page's RAW JSON. Catches a doc URL anywhere
  // the API returns it — hyperlink hrefs, mentions, nested rollups — regardless
  // of property type or how getPropText serialises it.
  if (!finalDocValue || !extractDocFileId(finalDocValue)) {
    try {
      const raw = JSON.stringify(props);
      const m = raw.match(DOC_IN_JSON_RX);
      if (m) finalDocValue = 'https://docs.google.com/document/d/' + m[1] + '/edit';
    } catch {}
  }

  // Externally resolved (relation fallback)
  if ((!finalDocValue || !extractDocFileId(finalDocValue)) && overrideDocUrl) {
    finalDocValue = overrideDocUrl;
  }

  if (!finalDocValue) return null;
  const keys = allDocKeys(finalDocValue);
  if (!keys.length) return null;

  const actualPaid   = props[config.propActualPaid]?.number ?? null;
  const currencyType = getPropText(props[config.propCurrencyType] || null);
  const postType     = getPropText(props['Post Type']          || null);
  const orderIn      = getPropText(props['Order In']           || null);
  const orderUrl     = getPropText(props['Order URL']          || null);
  const txnDetails   = getPropText(props['Transaction Details']|| null);
  const clientSheet  = getPropText(props['Client Sheet']       || null);
  const pageUrl      = `https://www.notion.so/${page.id.replace(/-/g,'')}`;

  return { keys, entry:{ pageId:page.id, actualPaid, currencyType, postType, orderIn, orderUrl, txnDetails, clientSheet, pageUrl, finalDocValue } };
}

// ── RELATION FALLBACK ─────────────────────────────────────────────────────────
// Some cards reference their doc only through a relation: a formula like
//   if( empty(Article DOC), From Writers, Article DOC )
// where "From Writers" rolls up a related Writers page. Unknown-type formulas
// often serialise as EMPTY through the API, and the query response carries
// only the related page's id — so fetch that page and scan it for a doc URL.
function relationIdsFromPage(page) {
  const ids = [];
  for (const propVal of Object.values(page.properties || {})) {
    if (propVal?.type === 'relation') {
      for (const r of (propVal.relation || [])) if (r?.id) ids.push(r.id);
    }
  }
  return ids;
}

async function docUrlFromRelations(page, config, relCache) {
  const headers = notionHeaders(config.apiKey);
  for (const rid of relationIdsFromPage(page).slice(0, 5)) {
    try {
      let raw = relCache[rid];
      if (raw === undefined) {
        const res = await notionFetchHttp(`https://api.notion.com/v1/pages/${rid}`, { method:'GET', headers });
        raw = res.ok ? JSON.stringify((await res.json()).properties || {}) : '';
        relCache[rid] = raw;
      }
      const m = raw.match(DOC_IN_JSON_RX);
      if (m) return 'https://docs.google.com/document/d/' + m[1] + '/edit';
    } catch {}
  }
  return null;
}

// For pages that yielded no doc URL locally, resolve via their relations with
// limited concurrency. `cap` bounds the extra API calls per build/sync so a DB
// full of doc-less pages can't stall everything.
async function resolveMissingViaRelations(pages, parsed, config, relCache, cap) {
  const idxs = [];
  for (let i = 0; i < pages.length; i++) {
    if (!parsed[i] && relationIdsFromPage(pages[i]).length) idxs.push(i);
  }
  if (!idxs.length) return;
  let cursor = 0;
  const worker = async () => {
    while (cursor < idxs.length && cap.used < cap.cap) {
      const i = idxs[cursor++];
      cap.used++;
      const docUrl = await docUrlFromRelations(pages[i], config, relCache);
      if (docUrl) {
        parsed[i] = pageEntryFromNotion(pages[i], config, docUrl);
        if (parsed[i]) console.log(`[GPL bg] Doc resolved via relation for page ${pages[i].id.slice(0,8)}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

// ── MESSAGE ROUTER ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  if (msg.action === 'appendSheet') {
    appendViaAppsScript(msg.rows, msg.webAppUrl)
      .then(r => respond({ ok:true, result:r })).catch(e => respond({ ok:false, error:e.message }));
    return true;
  }
  if (msg.action === 'notionFetch') {
    notionFetchCard(msg.docUrl, msg.config)
      .then(r => respond({ ok:true, ...r })).catch(e => respond({ ok:false, error:e.message }));
    return true;
  }
  if (msg.action === 'notionFetchBatch') {
    notionFetchBatch(msg.docUrls, msg.config)
      .then(r => respond({ ok:true, results:r })).catch(e => respond({ ok:false, error:e.message }));
    return true;
  }
  if (msg.action === 'notionUpdate') {
    notionUpdateCard(msg.pageId, msg.liveUrl, msg.invoiceUrl, msg.paymentStatus, msg.config)
      .then(r => respond({ ok:true, result:r })).catch(e => respond({ ok:false, error:e.message }));
    return true;
  }
  if (msg.action === 'notionRebuildCache') {
    _pages={}; _fetchedAt=null; _incrementalAt=null; _cacheLoaded=true; _buildInProgress=false;
    notionBuildCache(msg.config)
      .then(count => respond({ ok:true, count })).catch(e => respond({ ok:false, error:e.message }));
    return true;
  }
  if (msg.action === 'fetchDoc') {
    fetchDocViaAppsScript(msg.docUrl, msg.webAppUrl)
      .then(r => respond({ ok:true, ...r })).catch(e => respond({ ok:false, error:e.message, anchors:[], bodyText:'' }));
    return true;
  }
  if (msg.action === 'validate' || msg.action === 'validateLive') {
    validateViaAppsScript(msg.liveUrl, msg.docAnchors||[], msg.docText||'', msg.webAppUrl)
      .then(r => respond({ ok:true, checks:r.checks||[] })).catch(e => respond({ ok:false, error:e.message, checks:[] }));
    return true;
  }
  if (msg.action === 'validateWithDoc') {
    validateWithDocViaAppsScript(msg.liveUrl, msg.docUrl, msg.webAppUrl)
      .then(r => respond({ ok:true, checks:r.checks||[], docAnchors:r.docAnchors||[], docText:r.docText||'' }))
      .catch(e => respond({ ok:false, error:e.message, checks:[] }));
    return true;
  }

  // v27: Write live link into the correct row of the client Google Sheet
  if (msg.action === 'writeLiveToClientSheet') {
    writeLiveToClientSheetViaAppsScript(msg.clientSheetUrl, msg.docUrl, msg.liveUrl, msg.webAppUrl)
      .then(r => respond({ ok:true, ...r }))
      .catch(e => respond({ ok:false, error:e.message }));
    return true;
  }
});

// ── APPS SCRIPT ───────────────────────────────────────────────────────────────
async function appendViaAppsScript(rows, webAppUrl) {
  if (!webAppUrl || !webAppUrl.startsWith('https://script.google.com'))
    throw new Error('Invalid Apps Script URL. Set it in ⚙ Settings.');
  const res = await fetch(webAppUrl, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ values:rows }), redirect:'follow',
  });
  if (!res.ok && res.status !== 302) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Apps Script error ${res.status}: ${txt.slice(0,150)}`);
  }
  let json; try { json = await res.json(); } catch { json = { status:'ok' }; }
  if (json.status === 'error') throw new Error('Apps Script: ' + (json.message||'Unknown error'));
  return json;
}

// ── SCHEMA ────────────────────────────────────────────────────────────────────
async function ensureSchema(config) {
  try {
    const res = await notionFetchHttp(
      `https://api.notion.com/v1/databases/${config.databaseId}`,
      { method:'GET', headers:notionHeaders(config.apiKey) }
    );
    if (!res.ok) return;
    const dbData = await res.json();
    _schemaTypes = {};
    _schemaRelations = {};
    for (const [name, prop] of Object.entries(dbData.properties || {})) {
      _schemaTypes[name] = prop.type;
      if (prop.type === 'relation' && prop.relation?.database_id) {
        _schemaRelations[name] = prop.relation.database_id;
      }
    }
    await saveSchemaToStorage();
    console.log('[GPL bg] Schema:', JSON.stringify(_schemaTypes), 'relations:', JSON.stringify(_schemaRelations));
  } catch(e) { console.warn('[GPL bg] Schema failed:', e.message); }
}

// ── INCREMENTAL SYNC ──────────────────────────────────────────────────────────
async function notionIncrementalSync(config) {
  if (!config.apiKey || !config.databaseId) return 0;
  const headers = notionHeaders(config.apiKey);
  let added = 0, cursor = null, page = 0;
  const relCache = {}, relCap = { used: 0, cap: 40 };
  try {
    while (page < 3) { // fetch up to 300 most-recently-edited pages
      const payload = {
        page_size: 100,
        sorts: [{ timestamp:'last_edited_time', direction:'descending' }],
      };
      if (cursor) payload.start_cursor = cursor;
      const res = await notionFetchHttp(
        `https://api.notion.com/v1/databases/${config.databaseId}/query`,
        { method:'POST', headers, body:JSON.stringify(payload) }
      );
      if (!res.ok) break;
      const data = await res.json();
      const pages = data.results || [];
      const parsedList = pages.map(p => pageEntryFromNotion(p, config));
      await resolveMissingViaRelations(pages, parsedList, config, relCache, relCap);
      for (const parsed of parsedList) {
        if (!parsed) continue;
        for (const key of parsed.keys) { if (!_pages[key]) added++; _pages[key] = parsed.entry; }
      }
      page++;
      if (!data.has_more) break;
      cursor = data.next_cursor;
    }
    _incrementalAt = Date.now();
    if (added > 0) { await saveCacheToStorage(); console.log(`[GPL bg] Incremental: +${added}`); }
    return added;
  } catch(e) { console.warn('[GPL bg] Incremental failed:', e.message); return 0; }
}

// ── FULL CACHE BUILD ──────────────────────────────────────────────────────────
async function notionBuildCache(config) {
  if (!config.apiKey)     throw new Error('Notion API key not set.');
  if (!config.databaseId) throw new Error('Notion Database ID not set.');
  if (_buildInProgress) {
    for (let i = 0; i < 150; i++) { await new Promise(r => setTimeout(r, 200)); if (!_buildInProgress) break; }
    return Object.keys(_pages).length;
  }
  _buildInProgress = true;
  const headers = notionHeaders(config.apiKey);
  let cursor = null, hasMore = true, total = 0;
  const newPages = {};
  const relCache = {}, relCap = { used: 0, cap: 500 };
  try {
    while (hasMore) {
      const payload = { page_size:100 };
      if (cursor) payload.start_cursor = cursor;
      const res = await notionFetchHttp(
        `https://api.notion.com/v1/databases/${config.databaseId}/query`,
        { method:'POST', headers, body:JSON.stringify(payload) }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`Notion API ${res.status}: ${err.message || res.statusText}`);
      }
      const data = await res.json();
      const pages = data.results || [];
      const parsedPages = pages.map(p => pageEntryFromNotion(p, config));
      // Pages with no readable doc URL: resolve through their relations
      // (doc may live on the related Writers page) — capped per build
      await resolveMissingViaRelations(pages, parsedPages, config, relCache, relCap);
      for (const parsed of parsedPages) {
        if (!parsed) continue;
        for (const key of parsed.keys) newPages[key] = parsed.entry;
        total++;
      }
      hasMore = data.has_more || false;
      cursor  = data.next_cursor || null;
    }
    _pages = newPages; _fetchedAt = Date.now(); _incrementalAt = Date.now();
    await saveCacheToStorage();
    console.log(`[GPL bg] Cache built: ${total} pages → ${Object.keys(newPages).length} keys`);
    return total;
  } finally { _buildInProgress = false; }
}

// ── DIRECT API SEARCH — primary lookup path (v27.1) ─────────────────────────────
// One filtered databases/query call resolves a doc in ~0.5s, instead of
// paginating the whole DB. Filters are built from the DB schema and run in
// parallel; wrong-type filters just return a 400 and are ignored.

// Filter every doc-ish property by its ACTUAL type. This finds pages whose
// Final Doc formula evaluates EMPTY through the API (unknown-type formulas)
// via their source properties instead — e.g. the "Article DOC" url property
// or the "From Writers" rollup of the related Writers page.
function buildDocFilters(docFileId, config) {
  const filters = [];
  const seen = new Set();
  const add = (name, type) => {
    if (!name || seen.has(name + '|' + type)) return;
    seen.add(name + '|' + type);
    if (type === 'rich_text')    filters.push({ property:name, rich_text:{ contains:docFileId } });
    else if (type === 'url')     filters.push({ property:name, url:{ contains:docFileId } });
    else if (type === 'formula') filters.push({ property:name, formula:{ string:{ contains:docFileId } } });
    else if (type === 'rollup') {
      filters.push({ property:name, rollup:{ any:{ rich_text:{ contains:docFileId } } } });
      filters.push({ property:name, rollup:{ any:{ url:{ contains:docFileId } } } });
    }
  };

  // Configured Final Doc property first — resolve the real name from the
  // schema (tolerates case/whitespace differences with the actual column)
  let propName = config.propFinalDoc;
  if (Object.keys(_schemaTypes).length && _schemaTypes[propName] === undefined) {
    const want = (propName || '').toLowerCase().trim();
    const ci = Object.keys(_schemaTypes).find(n => n.toLowerCase().trim() === want);
    if (ci) { propName = ci; console.log(`[GPL bg] Final Doc prop resolved to "${ci}"`); }
  }
  const knownType = _schemaTypes[propName];
  if (knownType) add(propName, knownType);
  else { add(propName, 'rich_text'); add(propName, 'url'); add(propName, 'formula'); }

  // Then every other doc-ish property in the schema
  for (const [name, type] of Object.entries(_schemaTypes)) {
    if (filters.length >= 10) break;
    if (name === propName) continue;
    if (!/doc|link|url|content|writer/i.test(name)) continue;
    add(name, type);
  }
  return filters.slice(0, 10);
}

async function notionDirectSearch(docUrl, docFileId, config) {
  if (!docFileId) return null;
  const headers = notionHeaders(config.apiKey);

  if (!Object.keys(_schemaTypes).length) await ensureSchema(config);
  const filters = buildDocFilters(docFileId, config);

  const searchResults = await Promise.allSettled(
    filters.map(filter =>
      notionFetchHttp(
        `https://api.notion.com/v1/databases/${config.databaseId}/query`,
        { method:'POST', headers, body:JSON.stringify({ page_size:5, filter }) }
      )
    )
  );

  const seen = new Set();
  for (const settled of searchResults) {
    if (settled.status !== 'fulfilled') continue;
    const res = settled.value;
    if (!res.ok) continue;
    try {
      const data = await res.json();
      for (const page of (data.results || [])) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        const parsed = pageEntryFromNotion(page, config);
        if (!parsed) continue;
        const pageDocId = extractDocFileId(parsed.entry.finalDocValue || '');
        if (pageDocId && pageDocId !== docFileId) continue;
        for (const key of parsed.keys) _pages[key] = parsed.entry;
        saveCacheToStorage(); // async, don't await
        console.log(`[GPL bg] Direct search found pageId=${page.id.slice(0,8)}`);
        return entryToSearchResult(parsed.entry);
      }
    } catch(e) { console.warn('[GPL bg] Direct search parse failed:', e.message); }
  }

  // Final stages — only reached when the original DB yields nothing:
  // generic relation hop, then the hardcoded Writers DB resolution chain.
  const hop = await notionRelationHopSearch(docFileId, config);
  if (hop) return hop;
  return await notionWritersDbSearch(docFileId, config);
}

function entryToSearchResult(entry) {
  return { pageId:entry.pageId, actualPaid:entry.actualPaid,
           currencyType:entry.currencyType, postType:entry.postType,
           orderIn:entry.orderIn, orderUrl:entry.orderUrl,
           txnDetails:entry.txnDetails, clientSheet:entry.clientSheet,
           pageUrl:entry.pageUrl };
}

// ── TWO-HOP RELATION SEARCH ───────────────────────────────────────────────────
// For order pages whose Final Doc formula evaluates empty via the API and
// whose doc URL lives on a RELATED page (e.g. "From Writers" rollup), no
// filter on the orders DB can match. Instead:
//   1. search each related database directly for the doc id (~1 query each)
//   2. hop back: query the orders DB with relation contains <matched page id>
// Cost is a handful of API calls regardless of database size.
async function notionRelationHopSearch(docFileId, config) {
  if (!docFileId) return null;
  const headers = notionHeaders(config.apiKey);
  if (!Object.keys(_schemaRelations).length) await ensureSchema(config);

  for (const [relProp, relDbId] of Object.entries(_schemaRelations)) {
    try {
      const relTypes = await getDbSchema(relDbId, headers);
      if (!relTypes) continue;

      // Search the related DB for the doc id across its text-bearing props
      const relFilters = buildTextFilters(relTypes, docFileId);
      if (!relFilters.length) continue;

      const relSettled = await Promise.allSettled(relFilters.map(f => notionFetchHttp(
        `https://api.notion.com/v1/databases/${relDbId}/query`,
        { method:'POST', headers, body:JSON.stringify({ page_size:3, filter:f }) }
      )));
      const relPageIds = [];
      for (const s of relSettled) {
        if (s.status !== 'fulfilled' || !s.value.ok) continue;
        try {
          const d = await s.value.json();
          for (const pg of (d.results || [])) if (!relPageIds.includes(pg.id)) relPageIds.push(pg.id);
        } catch {}
      }
      if (!relPageIds.length) continue;
      console.log(`[GPL bg] Relation-hop: doc found in related DB via "${relProp}" (${relPageIds.length} page(s))`);

      // Hop back: order pages related to the matched page(s)
      for (const pid of relPageIds.slice(0, 3)) {
        const res = await notionFetchHttp(
          `https://api.notion.com/v1/databases/${config.databaseId}/query`,
          { method:'POST', headers,
            body:JSON.stringify({ page_size:3, filter:{ property:relProp, relation:{ contains:pid } } }) }
        );
        if (!res.ok) continue;
        const data = await res.json();
        for (const page of (data.results || [])) {
          const parsed = pageEntryFromNotion(page, config,
            'https://docs.google.com/document/d/' + docFileId + '/edit');
          if (!parsed) continue;
          // The order page might carry its OWN (different) doc — only accept
          // it if it actually indexes under the doc id we searched for
          if (!parsed.keys.includes(docFileId)) continue;
          for (const key of parsed.keys) _pages[key] = parsed.entry;
          saveCacheToStorage();
          console.log(`[GPL bg] Relation-hop found order pageId=${page.id.slice(0,8)} via "${relProp}"`);
          return entryToSearchResult(parsed.entry);
        }
      }
    } catch(e) { console.warn(`[GPL bg] Relation-hop via "${relProp}" failed:`, e.message); }
  }
  return null;
}

// ── SHARED SCHEMA/FILTER HELPERS ─────────────────────────────────────────────
async function getDbSchema(dbId, headers) {
  if (_relDbSchemas[dbId]) return _relDbSchemas[dbId];
  try {
    const r = await notionFetchHttp(`https://api.notion.com/v1/databases/${dbId}`, { method:'GET', headers });
    if (!r.ok) return null;
    const d = await r.json();
    const types = {};
    for (const [n, p] of Object.entries(d.properties || {})) types[n] = p.type;
    _relDbSchemas[dbId] = types;
    return types;
  } catch { return null; }
}

function buildTextFilters(types, docFileId, max = 8) {
  const filters = [];
  for (const [n, t] of Object.entries(types)) {
    if (filters.length >= max) break;
    if (t === 'title')          filters.push({ property:n, title:{ contains:docFileId } });
    else if (t === 'rich_text') filters.push({ property:n, rich_text:{ contains:docFileId } });
    else if (t === 'url')       filters.push({ property:n, url:{ contains:docFileId } });
    else if (t === 'formula')   filters.push({ property:n, formula:{ string:{ contains:docFileId } } });
  }
  return filters;
}

function findProp(props, wanted) {
  if (props[wanted]) return props[wanted];
  const lk = wanted.toLowerCase().trim();
  for (const [n, v] of Object.entries(props)) if (n.toLowerCase().trim() === lk) return v;
  return null;
}

// ── WRITERS DB FALLBACK (hardcoded resolution chain) ─────────────────────────
// When the orders DB yields nothing for a doc id, the doc lives on a page in
// the Writers DB. That page's "2026 Order Management" property points back to
// the order page — as a relation, a link/mention, or just the order's NAME.
// Resolution: find writer page by doc id → follow the pointer → cache order.
const WRITERS_DB_ID   = '31fe3318538143458a8d4dfec9444b1c';
const ORDER_LINK_PROP = '2026 Order Management';
const NOTION_UUID_RX  = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

let _writersDiag = '';   // last Writers-DB lookup outcome, surfaced by diagnoseNotFound

async function notionWritersDbSearch(docFileId, config) {
  if (!docFileId) return null;
  const headers = notionHeaders(config.apiKey);
  const writersDbId = ((config.writersDbId || WRITERS_DB_ID) + '').replace(/[^a-zA-Z0-9]/g, '');
  const docProp     = config.writersDocProp   || 'Completed DOC';
  const orderProp   = config.writersOrderProp || ORDER_LINK_PROP;
  _writersDiag = '';
  try {
    // 1. Find the writer page(s) containing this doc id. Query the configured
    // doc property DIRECTLY with every plausible type — no schema read needed
    // (wrong-type filters 400 and are ignored). Schema-driven filters are
    // added as a bonus when the schema is readable.
    const filters = [
      { property: docProp, rich_text:{ contains: docFileId } },
      { property: docProp, url:{ contains: docFileId } },
      { property: docProp, formula:{ string:{ contains: docFileId } } },
      { property: docProp, title:{ contains: docFileId } },
    ];
    const wTypes = await getDbSchema(writersDbId, headers);
    if (wTypes) {
      for (const f of buildTextFilters(wTypes, docFileId)) {
        if (filters.length >= 12) break;
        if (f.property !== docProp) filters.push(f);
      }
    } else {
      console.warn(`[GPL bg] Writers DB schema not readable — querying "${docProp}" directly`);
    }

    const settled = await Promise.allSettled(filters.map(f => notionFetchHttp(
      `https://api.notion.com/v1/databases/${writersDbId}/query`,
      { method:'POST', headers, body:JSON.stringify({ page_size:3, filter:f }) }
    )));
    const writerPages = [];
    const seenW = new Set();
    let lastErr = '';
    for (const s of settled) {
      if (s.status !== 'fulfilled') { lastErr = s.reason?.message || 'network error'; continue; }
      if (!s.value.ok) {
        try { const e = await s.value.json(); lastErr = `${s.value.status} ${e.code || ''}: ${e.message || ''}`.trim(); }
        catch { lastErr = 'HTTP ' + s.value.status; }
        continue;
      }
      try {
        const d = await s.value.json();
        for (const pg of (d.results || [])) if (!seenW.has(pg.id)) { seenW.add(pg.id); writerPages.push(pg); }
      } catch {}
    }
    if (!writerPages.length) {
      _writersDiag = lastErr && !lastErr.startsWith('400')
        ? `Writers DB query failed (${lastErr}) — check the Writers DB ID and that the integration is connected to it.`
        : `Doc not found in Writers DB property "${docProp}" either.`;
      console.log('[GPL bg] Writers DB: ' + _writersDiag);
      return null;
    }
    console.log(`[GPL bg] Writers DB: ${writerPages.length} writer page(s) contain the doc`);

    const docUrlCanonical = 'https://docs.google.com/document/d/' + docFileId + '/edit';

    for (const wp of writerPages.slice(0, 3)) {
      const linkProp = findProp(wp.properties || {}, orderProp);
      if (!linkProp) {
        _writersDiag = `Writer page found, but it has no "${orderProp}" property to point back to the order.`;
        console.warn('[GPL bg] Writers DB: ' + _writersDiag);
        continue;
      }

      // 2a. Relation → order page id(s) directly
      let orderIds = [];
      if (linkProp.type === 'relation') {
        orderIds = (linkProp.relation || []).map(r => r?.id).filter(Boolean);
      }

      // 2b. Otherwise: any Notion page id / notion.so link inside the value
      if (!orderIds.length) {
        const raw = JSON.stringify(linkProp);
        const ids = (raw.match(NOTION_UUID_RX) || []).map(x => x.replace(/-/g, '').toLowerCase());
        orderIds = [...new Set(ids)].filter(x => x !== wp.id.replace(/-/g, '').toLowerCase());
      }

      for (const oid of orderIds.slice(0, 3)) {
        const result = await fetchOrderPageById(oid, config, docUrlCanonical);
        if (result) return result;
      }

      // 2c. Plain text → it's the order's NAME; look it up in the main DB title
      const name = getPropText(linkProp).trim();
      if (name && name.length >= 3 && !/^https?:/i.test(name)) {
        if (!Object.keys(_schemaTypes).length) await ensureSchema(config);
        const titleProp = Object.keys(_schemaTypes).find(n => _schemaTypes[n] === 'title') || 'Name';
        const res = await notionFetchHttp(
          `https://api.notion.com/v1/databases/${config.databaseId}/query`,
          { method:'POST', headers,
            body:JSON.stringify({ page_size:3, filter:{ property:titleProp, title:{ contains:name.slice(0,80) } } }) }
        );
        if (res.ok) {
          const d = await res.json();
          for (const page of (d.results || [])) {
            const result = cacheOrderPage(page, config, docUrlCanonical, `name "${name.slice(0,40)}"`);
            if (result) return result;
          }
        }
      }
      _writersDiag = `Writer page found and "${orderProp}" read, but the order it points to could not be resolved in the main DB.`;
    }
  } catch(e) { _writersDiag = 'Writers DB search failed: ' + e.message; console.warn('[GPL bg] ' + _writersDiag); }
  return null;
}

async function fetchOrderPageById(pageId, config, docUrlCanonical) {
  try {
    const headers = notionHeaders(config.apiKey);
    const res = await notionFetchHttp(`https://api.notion.com/v1/pages/${pageId}`, { method:'GET', headers });
    if (!res.ok) return null;
    const page = await res.json();
    // Only accept pages that actually belong to the orders database
    const parentDb = (page.parent?.database_id || '').replace(/-/g, '').toLowerCase();
    if (parentDb && parentDb !== (config.databaseId || '').replace(/-/g, '').toLowerCase()) return null;
    return cacheOrderPage(page, config, docUrlCanonical, 'page link');
  } catch { return null; }
}

// The writer page's pointer explicitly maps this doc to this order, so index
// the entry under the searched doc id even if the order page also carries its
// own (e.g. copied) doc URL.
function cacheOrderPage(page, config, docUrlCanonical, via) {
  const parsed = pageEntryFromNotion(page, config, docUrlCanonical);
  if (!parsed) return null;
  const keys = new Set([...parsed.keys, ...allDocKeys(docUrlCanonical)]);
  for (const key of keys) _pages[key] = parsed.entry;
  saveCacheToStorage();
  console.log(`[GPL bg] Writers DB: order ${page.id.slice(0,8)} resolved via ${via}`);
  return entryToSearchResult(parsed.entry);
}

// ── FETCH SINGLE CARD ─────────────────────────────────────────────────────────
async function notionFetchCard(docUrl, config) {
  if (!config.apiKey)     throw new Error('Notion API key not set. Open ⚙ Settings.');
  if (!config.databaseId) throw new Error('Notion Database ID not set. Open ⚙ Settings.');
  await loadCacheFromStorage();

  const docFileId = extractDocFileId(docUrl);
  if (!docFileId) throw new Error('Cannot extract Doc file ID from: ' + docUrl);

  const toResult = (c, fromCache) => ({
    pageId:c.pageId, actualPaid:c.actualPaid, currencyType:c.currencyType,
    postType:c.postType, orderIn:c.orderIn, orderUrl:c.orderUrl,
    txnDetails:c.txnDetails, clientSheet:c.clientSheet, pageUrl:c.pageUrl,
    docFileId, fromCache
  });

  // Step 1: immediate cache hit (normalise URL before lookup)
  const normDocUrl = normaliseDocUrl(docUrl);
  let cached = lookupDoc(normDocUrl) || lookupDoc(docUrl);
  if (cached) {
    // Kick off incremental sync in background — don't wait
    if (incrementalSyncDue()) notionIncrementalSync(config).catch(() => {});
    return toResult(cached, true);
  }

  // Step 2 (v27.1): targeted filtered query FIRST — one API round-trip.
  // Querying with a filter is how the Notion API is meant to be used for
  // lookups; scanning the whole DB into a cache is only a fallback.
  const direct = await notionDirectSearch(normDocUrl, docFileId, config);
  if (direct) {
    warmCacheInBackground(config);
    return { ...direct, docFileId, fromCache:false };
  }

  // Step 3: lightweight incremental sync (recent ~300 pages), then re-check.
  // Covers cards whose Final Doc property type defeats the filter.
  await notionIncrementalSync(config);
  cached = lookupDoc(normDocUrl) || lookupDoc(docUrl);
  if (cached) return toResult(cached, false);

  // Step 4: full DB scan fallback. The filtered query (step 2) cannot reliably
  // match formula-type Final Doc properties, so before declaring "not found" we
  // do one authoritative full scan — but skip it if the cache was just built
  // (<2min ago) so a genuinely-missing doc doesn't trigger repeated scans.
  const justBuilt = _fetchedAt && (Date.now() - _fetchedAt < 2 * 60 * 1000);
  if (!justBuilt) {
    await notionBuildCache(config);
    cached = lookupDoc(normDocUrl) || lookupDoc(docUrl);
    if (cached) return toResult(cached, false);
  }

  throw new Error(await diagnoseNotFound(docFileId, config));
}

// Refresh a stale cache without making any caller wait for it.
function warmCacheInBackground(config) {
  if (cacheIsValid() || _buildInProgress) return;
  notionBuildCache(config).catch(() => {});
}

// Explain WHY a doc could not be found, instead of a generic "rebuild cache".
async function diagnoseNotFound(docFileId, config) {
  const base = `Not found in Notion DB (docId: ${docFileId.slice(0,12)}…).`;
  try {
    if (!Object.keys(_schemaTypes).length) await ensureSchema(config);
    const names = Object.keys(_schemaTypes);
    if (!names.length) {
      return base + ' Could not read the database schema — check the API key, Database ID, and that the integration is connected to this database.';
    }
    const want = (config.propFinalDoc || '').toLowerCase().trim();
    const propName = _schemaTypes[config.propFinalDoc] !== undefined
      ? config.propFinalDoc
      : names.find(n => n.toLowerCase().trim() === want);
    if (!propName) {
      const docLike = names.filter(n => /doc|link|url|content/i.test(n));
      return base + ` Property "${config.propFinalDoc}" does not exist in this database. ` +
        (docLike.length ? `Did you mean: ${docLike.join(', ')}? ` : '') +
        'Fix the Final Doc property name in ⚙ Settings.';
    }
    const t = _schemaTypes[propName];
    return base + ` Property "${propName}" (type: ${t}) exists but no card contains this doc ID — ` +
      'the Notion card may link a DIFFERENT doc than the email (e.g. a copied doc). ' +
      'Open the card and compare its doc URL with the email’s.' +
      (_writersDiag ? ' ' + _writersDiag : '');
  } catch (e) {
    return base + ' Try ↻ Rebuild Cache if this is a new card.';
  }
}

// ── BATCH FETCH ───────────────────────────────────────────────────────────────
async function notionFetchBatch(docUrls, config) {
  if (!config.apiKey)     throw new Error('Notion API key not set.');
  if (!config.databaseId) throw new Error('Notion Database ID not set.');
  await loadCacheFromStorage();

  // v27.1: NEVER block the batch on a cache build. Serve cache hits instantly,
  // resolve misses with parallel filtered queries, refresh the cache in the
  // background for next time.
  if (_fetchedAt && incrementalSyncDue()) notionIncrementalSync(config).catch(() => {});
  warmCacheInBackground(config);

  const results = {};
  const missing = [];

  const cachedResult = (cached, docFileId) => ({
    ok:true, pageId:cached.pageId, actualPaid:cached.actualPaid,
    currencyType:cached.currencyType, postType:cached.postType, orderIn:cached.orderIn,
    orderUrl:cached.orderUrl, txnDetails:cached.txnDetails, clientSheet:cached.clientSheet,
    pageUrl:cached.pageUrl, docFileId });

  for (const docUrl of docUrls) {
    const docFileId = extractDocFileId(docUrl);
    if (!docFileId) { results[docUrl] = { ok:false, error:'Invalid doc URL' }; continue; }
    const cached = lookupDoc(docUrl);
    if (cached) results[docUrl] = cachedResult(cached, docFileId);
    else missing.push({ docUrl, docFileId });
  }

  // Parallel direct API searches for anything still missing
  if (missing.length > 0) {
    await Promise.allSettled(
      missing.map(async ({ docUrl, docFileId }) => {
        try {
          const direct = await notionDirectSearch(docUrl, docFileId, config);
          if (direct) results[docUrl] = { ok:true, ...direct, docFileId };
        } catch(e) { results[docUrl] = { ok:false, error:e.message }; }
      })
    );

    // Still unresolved → incremental sync, then ONE authoritative full scan
    // (catches formula-type docs the filter can't match), then final verdict.
    let still = missing.filter(m => !results[m.docUrl]);
    if (still.length > 0) {
      await notionIncrementalSync(config).catch(() => {});
      still = still.filter(m => {
        const cached = lookupDoc(m.docUrl);
        if (cached) { results[m.docUrl] = cachedResult(cached, m.docFileId); return false; }
        return true;
      });
    }
    if (still.length > 0) {
      const justBuilt = _fetchedAt && (Date.now() - _fetchedAt < 2 * 60 * 1000);
      if (!justBuilt) await notionBuildCache(config).catch(() => {});
      for (const { docUrl, docFileId } of still) {
        const cached = lookupDoc(docUrl);
        results[docUrl] = cached
          ? cachedResult(cached, docFileId)
          : { ok:false, error: await diagnoseNotFound(docFileId, config) };
      }
    }
  }
  return results;
}

// ── UPDATE CARD ───────────────────────────────────────────────────────────────
async function notionUpdateCard(pageId, liveUrl, invoiceUrl, paymentStatus, config) {
  if (!config.apiKey) throw new Error('Notion API key not set.');
  if (!pageId)        throw new Error('No Page ID — fetch Notion card first.');
  await loadCacheFromStorage();
  try { await ensureSchema(config); } catch(e) { console.warn('[GPL bg] Schema skip:', e.message); }

  const headers = notionHeaders(config.apiKey);

  function schemaType(propName) {
    if (!propName) return undefined;
    if (_schemaTypes[propName] !== undefined) return _schemaTypes[propName];
    const lower = propName.toLowerCase();
    for (const [k, v] of Object.entries(_schemaTypes)) {
      if (k.toLowerCase() === lower) return v;
    }
    return undefined;
  }

  const properties = {};

  if (liveUrl && config.propLiveLink) {
    const t = schemaType(config.propLiveLink);
    properties[config.propLiveLink] = (t === 'rich_text' || t === 'text')
      ? { rich_text: [{ type:'text', text:{ content: liveUrl } }] }
      : { url: liveUrl };
    console.log(`[GPL bg] LiveLink type="${t||'url'}"`);
  }

  if (invoiceUrl && invoiceUrl.trim() && config.propVendorInvoice) {
    const t = schemaType(config.propVendorInvoice);
    console.log(`[GPL bg] VendorInvoice prop="${config.propVendorInvoice}" type="${t||'unknown'}"`);
    properties[config.propVendorInvoice] = t === 'url'
      ? { url: invoiceUrl }
      : { rich_text: [{ type:'text', text:{ content: invoiceUrl.slice(0,2000) } }] };
  }

  if (config.propPaymentStatus && paymentStatus) {
    const t = schemaType(config.propPaymentStatus) || 'status';
    properties[config.propPaymentStatus] = t === 'select'
      ? { select:{ name:paymentStatus } }
      : { status:{ name:paymentStatus } };
  }

  console.log('[GPL bg] PATCH props:', JSON.stringify(Object.keys(properties)));

  const patchPage = async (props) => {
    const res = await notionFetchHttp(
      `https://api.notion.com/v1/pages/${pageId}`,
      { method:'PATCH', headers, body:JSON.stringify({ properties:props }) }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[GPL bg] PATCH error:', JSON.stringify(err));
      throw new Error(`Notion ${res.status}: ${err.message || res.statusText}`);
    }
    return await res.json();
  };

  const clearCache = () => {
    for (const [k, v] of Object.entries(_pages)) { if (v.pageId === pageId) { delete _pages[k]; break; } }
    saveCacheToStorage();
  };

  // Attempt 1: all together
  try {
    const result = await patchPage(properties);
    clearCache();
    return result;
  } catch(e1) {
    const isValErr = e1.message.includes('is not a property') ||
                     e1.message.includes('400') ||
                     e1.message.includes('validation_error') ||
                     e1.message.includes('invalid_request');
    if (!isValErr) throw e1;
    console.warn('[GPL bg] Batch PATCH failed, trying per-property:', e1.message);
  }

  // Attempt 2: per-property with retry
  const errors = [];
  let anySuccess = false, lastResult = null;
  for (const [propName, propValue] of Object.entries(properties)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        lastResult = await patchPage({ [propName]: propValue });
        anySuccess = true;
        console.log(`[GPL bg] ✓ "${propName}" saved`);
        break;
      } catch(e2) {
        if (attempt === 1) { errors.push(`${propName}: ${e2.message.slice(0,100)}`); }
        else await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  if (anySuccess) {
    clearCache();
    return lastResult?._partialErrors ? lastResult : { ...lastResult, _partialErrors: errors.length ? errors : undefined };
  }
  throw new Error('All property updates failed: ' + errors.join(' | '));
}

// ── APPS SCRIPT PROXIES ───────────────────────────────────────────────────────
async function validateWithDocViaAppsScript(liveUrl, docUrl, webAppUrl) {
  if (!webAppUrl || !webAppUrl.startsWith('https://script.google.com'))
    throw new Error('Apps Script URL not configured. Open ⚙ Settings.');
  const res = await fetch(webAppUrl, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ action:'validateWithDoc', liveUrl, docUrl }), redirect:'follow',
  });
  if (!res.ok && res.status !== 302) throw new Error('Apps Script error ' + res.status);
  let json; try { json = await res.json(); } catch { json = { status:'ok', checks:[] }; }
  if (json.status === 'error') throw new Error('Apps Script: ' + (json.message||'Unknown'));
  return { checks:json.checks||[], docAnchors:json.docAnchors||[], docText:json.docText||'' };
}

async function validateViaAppsScript(liveUrl, docAnchors, docText, webAppUrl) {
  if (!webAppUrl || !webAppUrl.startsWith('https://script.google.com'))
    throw new Error('Apps Script URL not configured. Open ⚙ Settings.');
  const res = await fetch(webAppUrl, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ action:'validate', liveUrl, docAnchors:docAnchors||[], docText:docText||'' }), redirect:'follow',
  });
  if (!res.ok && res.status !== 302) throw new Error('Apps Script error ' + res.status);
  let json; try { json = await res.json(); } catch { json = { status:'ok', checks:[] }; }
  if (json.status === 'error') throw new Error('Apps Script: ' + (json.message||'Unknown'));
  return { checks:json.checks||[] };
}

async function fetchDocViaAppsScript(docUrl, webAppUrl) {
  if (!webAppUrl || !webAppUrl.startsWith('https://script.google.com'))
    throw new Error('Apps Script URL not configured.');
  const res = await fetch(webAppUrl, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({ action:'fetchDoc', docUrl }), redirect:'follow',
  });
  if (!res.ok && res.status !== 302) throw new Error('Apps Script error ' + res.status);
  let json; try { json = await res.json(); } catch { json = { status:'ok', anchors:[], bodyText:'' }; }
  if (json.status === 'error') throw new Error(json.message||'Doc fetch failed');
  return { anchors:json.anchors||[], bodyText:json.bodyText||'', h1:json.h1||'', method:json.method||'' };
}

// ── WRITE LIVE LINK TO CLIENT SHEET (v27) ─────────────────────────────────────
// Calls the Apps Script web app with action='writeLiveToClientSheet'.
// The Apps Script finds the row matching docUrl in the Article Doc column
// and writes liveUrl into the Live link column.
async function writeLiveToClientSheetViaAppsScript(clientSheetUrl, docUrl, liveUrl, webAppUrl) {
  if (!webAppUrl || !webAppUrl.startsWith('https://script.google.com'))
    throw new Error('Invalid Apps Script URL. Set it in ⚙ Settings.');
  if (!clientSheetUrl) throw new Error('No Client Sheet URL — fetch Notion card first.');
  if (!docUrl)         throw new Error('No Article Doc URL provided.');
  if (!liveUrl)        throw new Error('No Live Link URL provided.');

  const res = await fetch(webAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'writeLiveToClientSheet',
      clientSheetUrl,
      docUrl,
      liveUrl,
    }),
    redirect: 'follow',
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'error') throw new Error(data.message || 'Apps Script error');
  return data; // { status:'ok', row, col, colHeader, message }
}
