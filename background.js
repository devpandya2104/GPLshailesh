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
    if (s[SCHEMA_KEY]) _schemaTypes = s[SCHEMA_KEY] || {};
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
  try { await chrome.storage.local.set({ [SCHEMA_KEY]: _schemaTypes }); } catch {}
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
    case 'rich_text': return (prop.rich_text || []).map(t => t.plain_text || '').join('');
    case 'title':     return (prop.title     || []).map(t => t.plain_text || '').join('');
    case 'select':    return prop.select?.name || '';
    case 'status':    return prop.status?.name || '';
    case 'number':    return String(prop.number ?? '');
    case 'email':     return prop.email || '';
    case 'phone_number': return prop.phone_number || '';
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
function pageEntryFromNotion(page, config) {
  const props = page.properties || {};

  // Try the configured Final Doc property name first
  let finalDocValue = '';
  const finalDocProp = props[config.propFinalDoc];
  if (finalDocProp) {
    finalDocValue = getPropText(finalDocProp);
  }

  // Fallback: search ALL properties for a Google Doc URL
  if (!finalDocValue || !extractDocFileId(finalDocValue)) {
    for (const [propName, propVal] of Object.entries(props)) {
      const val = getPropText(propVal);
      if (val && val.includes('docs.google.com/document') && extractDocFileId(val)) {
        finalDocValue = val;
        console.log(`[GPL bg] Found doc URL in prop "${propName}": ${val.slice(0,60)}`);
        break;
      }
    }
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
    for (const [name, prop] of Object.entries(dbData.properties || {})) _schemaTypes[name] = prop.type;
    await saveSchemaToStorage();
    console.log('[GPL bg] Schema:', JSON.stringify(_schemaTypes));
  } catch(e) { console.warn('[GPL bg] Schema failed:', e.message); }
}

// ── INCREMENTAL SYNC ──────────────────────────────────────────────────────────
async function notionIncrementalSync(config) {
  if (!config.apiKey || !config.databaseId) return 0;
  const headers = notionHeaders(config.apiKey);
  let added = 0, cursor = null, page = 0;
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
      for (const p of (data.results || [])) {
        const parsed = pageEntryFromNotion(p, config);
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
      // Parse pages in parallel (CPU-bound but still faster than serial)
      const parsedPages = await Promise.all(
        (data.results || []).map(p => Promise.resolve(pageEntryFromNotion(p, config)))
      );
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
// paginating the whole DB. Filter strategies run in parallel because the
// Final Doc property may be rich_text, url, or formula — wrong-type filters
// just return a 400 and are ignored.
async function notionDirectSearch(docUrl, docFileId, config) {
  if (!docFileId) return null;
  const headers = notionHeaders(config.apiKey);

  const filters = [
    { property: config.propFinalDoc, rich_text:{ contains: docFileId } },
    { property: config.propFinalDoc, url:{ contains: docFileId } },
    { property: config.propFinalDoc, formula:{ string:{ contains: docFileId } } },
  ];

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
        return { pageId:parsed.entry.pageId, actualPaid:parsed.entry.actualPaid,
                 currencyType:parsed.entry.currencyType, postType:parsed.entry.postType,
                 orderIn:parsed.entry.orderIn, orderUrl:parsed.entry.orderUrl,
                 txnDetails:parsed.entry.txnDetails, clientSheet:parsed.entry.clientSheet,
                 pageUrl:parsed.entry.pageUrl };
      }
    } catch(e) { console.warn('[GPL bg] Direct search parse failed:', e.message); }
  }
  return null;
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

  // Step 4: full DB scan ONLY if the cache has never been built (first run).
  // A stale cache is refreshed in the background instead of blocking here.
  if (!_fetchedAt) {
    await notionBuildCache(config);
    cached = lookupDoc(normDocUrl) || lookupDoc(docUrl);
    if (cached) return toResult(cached, false);
  } else {
    warmCacheInBackground(config);
  }

  throw new Error(`Not found in Notion DB (docId: ${docFileId.slice(0,12)}…). Try ↻ Rebuild Cache if this is a new card.`);
}

// Refresh a stale cache without making any caller wait for it.
function warmCacheInBackground(config) {
  if (cacheIsValid() || _buildInProgress) return;
  notionBuildCache(config).catch(() => {});
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

    // Still unresolved → one incremental sync (recent ~300 pages), re-check
    const still = missing.filter(m => !results[m.docUrl]);
    if (still.length > 0) {
      await notionIncrementalSync(config).catch(() => {});
      for (const { docUrl, docFileId } of still) {
        const cached = lookupDoc(docUrl);
        results[docUrl] = cached
          ? cachedResult(cached, docFileId)
          : { ok:false, error:`Not found (docId: ${docFileId.slice(0,12)}…). Rebuild Cache.` };
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
