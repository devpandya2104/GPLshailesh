// ================================================================
//  GPL content.js — v22.0  FINAL
//  GuestPostLinks Order Tracker
//
//  KEY FIXES v22:
//  ─────────────
//  FIX 1 — Extract orders from FIRST EMAIL ONLY
//    Order ID, Publisher Site, Doc URL come exclusively from the
//    FIRST/OLDEST email in the thread (the order notification).
//    Live links and invoice links come from the full thread.
//
//  FIX 2 — Deduplication by PayPal invoice
//    Same PayPal URL appearing in multiple messages = same order.
//    Do NOT create a new card for each mention of the same invoice.
//
//  FIX 3 — Context invalidation guard (FIX 1 from v21)
//  FIX 4 — Shadow DOM traversal
//  FIX 5 — Left panel contamination guard
// ================================================================

(function () {
  'use strict'; // GPL content.js v27

  if (window.__GPL_V26__) return;
  window.__GPL_V26__ = true;

  if (!location.hostname.includes('missiveapp.com')) return;

  // ── CONTEXT GUARD ─────────────────────────────────────────────
  function ctxOk() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }
  function safeStorageSet(data) {
    if (!ctxOk()) return;
    try { chrome.storage.local.set(data); } catch {}
  }

  // ─── DOMAIN LISTS ────────────────────────────────────────────

  const INVOICE_DOMAINS = new Set([
    'paypal.com','paypal.me','payoneer.com','link.payoneer.com',
    'wise.com','transferwise.com','stripe.com','invoice.stripe.com',
    'zoho.com','invoice.zoho.com','books.zoho.com',
    'razorpay.com','bill.com','freshbooks.com',
    'quickbooks.intuit.com','invoiceninja.com',
    'wave.com','waveapps.com','xero.com','paddle.com','melio.com',
    '2checkout.com','paypai.com','zohosecurepay.com',
    'secure.zohosecurepay.com','zohobooks.com',
    'checkout.razorpay.com','instamojo.com','paytm.com',
    'cashfree.com','flutterwave.com','gumroad.com',
    'lemon.squeezy.com','squareup.com','square.com',
  ]);

  const SKIP_LIVE = new Set([
    'app.missiveapp.com','mail.missiveapp.com','missiveapp.com',
    'links.missiveapp.com','link.missiveapp.com',
    'docs.google.com','drive.google.com','mail.google.com',
    'accounts.google.com','google.com','googleapis.com',
    'gstatic.com','googleusercontent.com','fonts.googleapis.com',
    'facebook.com','fb.com','twitter.com','x.com',
    'linkedin.com','instagram.com','youtube.com','youtu.be',
    'telegram.org','t.me','whatsapp.com','wa.me',
    'guestpostlinks.net','guestpostlinks.com',
    'crisp.chat','go.crisp.chat','widget.crisp.chat',
    'intercom.io','zendesk.com','tawk.to',
    'outlook.com','hotmail.com','microsoft.com','office.com',
    'teams.live.com','teams.microsoft.com','live.com',
    'meet.google.com','zoom.us','whereby.com','webex.com',
    'calendly.com','hubspot.com','salesforce.com',
    'amazonaws.com','cloudfront.net','cloudflare.com',
    'wp.com','wordpress.com','gravatar.com',
    'mailchimp.com','sendgrid.net','mailgun.org',
    'bit.ly','tinyurl.com','ow.ly','buff.ly','rebrand.ly',
    'apple.com','icloud.com','skype.com','discord.com','slack.com',
    'notion.so','airtable.com','trello.com','asana.com',
    'schema.org','w3.org','canva.com','figma.com',
    'serpzilla.com','ahrefs.com','semrush.com','moz.com',
    'dropbox.com','box.com',
    'paypal.com','payoneer.com','wise.com','stripe.com','zoho.com',
    'razorpay.com','freshbooks.com','zohosecurepay.com',
    'instamojo.com','paytm.com','cashfree.com','flutterwave.com',
    'gumroad.com','squareup.com','square.com',
  ]);

  const SKIP_PATHS = [
    '/unsubscribe','/opt-out','/optout','/email-preferences',
    '/tracking','/pixel','/beacon','/open.php','/click.php',
    '/wp-content/uploads','/wp-includes','/wp-admin','/wp-json',
    '/cdn-cgi/','/static/','/assets/','/_next/',
    '.jpg','.jpeg','.png','.gif','.webp','.svg','.ico',
    '.css','.js','.woff','.woff2','.ttf',
    '.pdf','.zip','.mp4','.mp3',
    '/feed','/rss','/sitemap','/privacy','/terms',
    '/login','/register','/signup',
  ];

  const NEVER_SITE = new Set([
    'missiveapp.com','app.missiveapp.com','mail.missiveapp.com',
    'guestpostlinks.net','guestpostlinks.com',
    'google.com','docs.google.com','gmail.com','googleapis.com',
    'paypal.com','payoneer.com','wise.com','stripe.com',
    'facebook.com','twitter.com','x.com','linkedin.com',
    'instagram.com','youtube.com','telegram.org','whatsapp.com',
    'crisp.chat','intercom.io','tawk.to',
    'microsoft.com','outlook.com','apple.com','teams.live.com',
    'wordpress.com','wp.com','zoom.us','calendly.com',
  ]);

  // ─── URL HELPERS ──────────────────────────────────────────────

  const isHttp = s => typeof s === 'string' && (s.startsWith('http://') || s.startsWith('https://'));

  function cleanUrl(raw) {
    return (raw || '')
      .replace(/[""''\u2018\u2019\u201C\u201D<>()\[\]{}\s,;\\\n\r]+$/g, '')
      .replace(/&amp;/g, '&').replace(/&#38;/g, '&')
      .replace(/\u200B/g, '').trim();
  }

  function unwrap(raw) {
    const u = cleanUrl(raw || '');
    if (!isHttp(u)) return u;
    try {
      const p = new URL(u);
      if (p.hostname.includes('missive')) {
        for (const k of ['url','u','link','redirect','target','dest','to','href']) {
          const v = p.searchParams.get(k);
          if (v) { try { const d = decodeURIComponent(v); if (isHttp(d)) return cleanUrl(d); } catch {} }
        }
      }
    } catch {}
    return u;
  }

  function getHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
  }

  function rootDomain(input) {
    if (!input) return '';
    let h = input.includes('://') ? getHost(input) : input.toLowerCase();
    h = h.split('/')[0].split('?')[0].split('#')[0].replace(/^www\./, '').trim();
    const parts = h.split('.');
    if (parts.length < 2) return h;
    const cc = ['co.uk','co.in','co.nz','co.za','co.jp','co.ke','co.tz','co.ug',
                 'co.au','com.au','com.br','com.mx','com.ar','com.co','com.ng',
                 'org.uk','net.uk','me.uk'];
    if (parts.length >= 3 && cc.includes(parts.slice(-2).join('.'))) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  }

  const isInvoice = url => {
    const h = getHost(url);
    return INVOICE_DOMAINS.has(h) || [...INVOICE_DOMAINS].some(d => h.endsWith('.' + d));
  };

  const isGoogleDoc = url => (
    url.includes('docs.google.com/document') ||
    url.includes('docs.google.com/open') ||
    (url.includes('google.com/open') && url.includes('id=')) ||
    (url.includes('drive.google.com') && url.includes('id='))
  );

  function isSkipForLive(url) {
    if (!isHttp(url)) return true;
    if (isGoogleDoc(url) || url.includes('docs.google.com') ||
        url.includes('drive.google.com') ||
        (url.includes('google.com/open') && url.includes('id='))) return true;
    if (isInvoice(url)) return true;
    const h = getHost(url);
    if (SKIP_LIVE.has(h) || [...SKIP_LIVE].some(d => h.endsWith('.' + d))) return true;
    const low = url.toLowerCase();
    if (SKIP_PATHS.some(p => low.includes(p))) return true;
    try { if (new URL(url).pathname.replace(/\/+$/, '').length < 3) return true; } catch { return true; }
    return false;
  }

  function domainsMatch(a, b) {
    if (!a || !b) return false;
    const ra = rootDomain(a), rb = rootDomain(b);
    return !!(ra && rb && (ra === rb || rb.endsWith('.' + ra) || ra.endsWith('.' + rb)));
  }

  function slugTokens(url) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      return path.split(/[-\/_.]+/).filter(t => t.length > 2 && !/^\d+$/.test(t));
    } catch { return []; }
  }

  function levenshteinSim(a, b) {
    if (!a || !b) return 0;
    const L = a.length >= b.length ? a : b, S = a.length >= b.length ? b : a;
    if (!L.length) return 1;
    if (L.length > 400) return L.slice(0, 200) === S.slice(0, 200) ? 1 : 0.4;
    const m = [];
    for (let i = 0; i <= S.length; i++) m[i] = [i];
    for (let j = 0; j <= L.length; j++) m[0][j] = j;
    for (let i = 1; i <= S.length; i++)
      for (let j = 1; j <= L.length; j++)
        m[i][j] = S[i-1] === L[j-1] ? m[i-1][j-1] : 1 + Math.min(m[i-1][j-1], m[i][j-1], m[i-1][j]);
    return (L.length - m[S.length][L.length]) / L.length;
  }

  function tokenOverlap(tA, tB) {
    if (!tA.length || !tB.length) return 0;
    let hits = 0;
    for (const t of tA) { if (tB.some(u => levenshteinSim(t, u) > 0.75)) hits++; }
    return hits / Math.max(tA.length, tB.length);
  }

  function extractDocFileId(url) {
    if (!url) return null;
    // /d/FILE_ID  — standard docs.google.com/document/d/...
    const m1 = url.match(/\/d\/([a-zA-Z0-9_-]{25,})/);
    if (m1) return m1[1];
    // ?id=FILE_ID or &id=FILE_ID  — google.com/open?id=... drive links
    const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]{25,})/);
    if (m2) return m2[1];
    // /file/d/FILE_ID  — drive.google.com/file/d/...
    const m3 = url.match(/\/file\/d\/([a-zA-Z0-9_-]{25,})/);
    if (m3) return m3[1];
    return null;
  }

  // Normalise any Google Doc/Drive URL variant to canonical form.
  // google.com/open?id=ID  ->  https://docs.google.com/document/d/ID/edit
  function normaliseDocUrl(url) {
    const id = extractDocFileId(url);
    if (!id) return url;
    return 'https://docs.google.com/document/d/' + id + '/edit';
  }

  // ─── SHADOW DOM TRAVERSAL ─────────────────────────────────────

  function collectLinksDeep(root, seen, links) {
    if (!root) return;
    try {
      root.querySelectorAll('a[href]').forEach(el => {
        if (el.closest && el.closest('#gpl-root')) return;
        let r = unwrap(cleanUrl(el.href || ''));
        if (isGoogleDoc && isGoogleDoc(r)) r = normaliseDocUrl ? normaliseDocUrl(r) : r;
        if (isHttp(r) && !seen.has(r)) { seen.add(r); links.push(r); }
        const txt = (el.textContent || '').trim();
        if (isHttp(txt)) {
          const t2 = unwrap(cleanUrl(txt));
          if (isHttp(t2) && !seen.has(t2)) { seen.add(t2); links.push(t2); }
        }
      });
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) collectLinksDeep(el.shadowRoot, seen, links);
      });
    } catch {}
  }

  // ─── EMAIL BODY ISOLATION ─────────────────────────────────────
  // KEY: We want to isolate the FIRST email from follow-ups/replies

  const ORDER_KEYWORDS = [
    /Order\s+ID\s*:/i,
    /Publisher\s*Site\s*:/i,
    /\bWebsite\s*:/i,
    /Content\s*Link\s*:/i,
    /Article\s+Publication/i,
    /GUESTPOSTLINKS/i,
    /anchor\s+text/i,
    /Deliverables\s*:/i,
  ];

  const REPLY_KEYWORDS = [
    /articles?\s+have.*been\s+published/i,
    /already\s+been\s+published/i,
    /article\s+has\s+been\s+published/i,
    /post(?:s)?\s+(?:are|is)\s+(?:now\s+)?live/i,
    /here\s+is\s+the\s+live/i,
    /live\s+link/i,
    /find\s+it\s+here/i,
    /invoice\s+paypal/i,
    /link\s+to\s+the\s+invoice/i,
    /pre-payment\s+has\s+been\s+processed/i,
    /Transaction\s+ID\s*:/i,
  ];

  function looksLikeOrderEmail(text) {
    if (text.length < 100) return false;
    return ORDER_KEYWORDS.some(rx => rx.test(text));
  }

  function looksLikeReplyEmail(text) {
    if (text.length < 50) return false;
    return REPLY_KEYWORDS.some(rx => rx.test(text));
  }

  // Collect individual shadow root text blocks, labeling each
  function collectEmailBlocks(root, blocks) {
    if (!root) return;
    try {
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) {
          try {
            const inner = (el.shadowRoot.firstElementChild?.innerText || el.shadowRoot.textContent || '')
              .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
              .replace(/\u00A0/g, ' ').replace(/\u200B/g, '')
              .replace(/[ \t]{3,}/g, '  ').trim();
            if (inner.length > 100) {
              blocks.push(inner);
            }
            collectEmailBlocks(el.shadowRoot, blocks);
          } catch {}
        }
      });
    } catch {}
  }

  function getEmailBlocks() {
    const rawBlocks = [];
    collectEmailBlocks(document, rawBlocks);

    // Also check iframes
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const cd = iframe.contentDocument || iframe.contentWindow?.document;
        if (!cd || !cd.body) return;
        const t = (cd.body.innerText || '').replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ').trim();
        if (t.length > 100) rawBlocks.push(t);
        collectEmailBlocks(cd, rawBlocks);
      } catch {}
    });

    // Fallback
    if (rawBlocks.length === 0) {
      const full = (document.body.innerText || '')
        .replace(/\r\n/g, '\n').replace(/\u00A0/g, ' ').replace(/\u200B/g, '').trim();
      rawBlocks.push(full);
    }

    return rawBlocks;
  }

  // ─── TEXT URL EXTRACTION ──────────────────────────────────────

  function extractTextUrls(text, seen) {
    const found = [];
    const rx = /https?:\/\/[^\s"'<>()\[\]{}\\\u200B\u00A0\n\r,;|]+/g;
    let m;
    while ((m = rx.exec(text)) !== null) {
      const u = unwrap(cleanUrl(m[0]));
      if (isHttp(u) && !seen.has(u)) { seen.add(u); found.push(u); }
    }
    return found;
  }

  // ─── PARSERS ──────────────────────────────────────────────────

  function parseSite(text) {
    const pats = [
      /Publisher\s*Site\s*[:\-]?\s*\n?\s*((?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.\-]{1,60}\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
      /\bWebsite\s*(?:URL\s*)?[:\-]?\s*\n?\s*((?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.\-]{1,60}\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
      /\bSite\s*(?:URL\s*)?[:\-]?\s*\n?\s*((?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.\-]{1,60}\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
      /\bDomain\s*[:\-]?\s*\n?\s*((?:https?:\/\/)?[a-zA-Z0-9][a-zA-Z0-9.\-]{1,60}\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/gi,
    ];
    const results = [], seen = new Set();
    for (const rx of pats) {
      for (const m of text.matchAll(rx)) {
        if (!m[1]) continue;
        let s = m[1].replace(/^https?:\/\//, '').replace(/\/.*$/, '')
          .replace(/[.,;:!?"'()\s]+$/, '').toLowerCase().trim();
        if (/^[a-z0-9][a-z0-9.\-]{1,62}\.[a-z]{2,}$/.test(s) && !s.includes(' ') &&
          s.length <= 80 && !NEVER_SITE.has(s) && !NEVER_SITE.has(rootDomain(s))) {
          const rd = rootDomain(s);
          if (!seen.has(rd)) { seen.add(rd); results.push(s); }
        }
      }
    }
    return results;
  }

  function parseOrderIds(text) {
    const strict = [...text.matchAll(/Order\s+ID\s*:\s*#?\s*(\d{4,})/gi)];
    if (strict.length) return strict.map(m => m[1].trim());
    const loose = [...text.matchAll(/Order\s*(?:#|No\.?)\s*:?\s*(\d{4,})/gi)];
    return loose.map(m => m[1].trim());
  }

  // Matches any Google Doc/Drive URL format and normalises to canonical form
  const DOC_URL_RX = /https?:\/\/(?:docs\.google\.com\/(?:document|open)|drive\.google\.com\/(?:file\/d|open))[^\s\n"'<>\)\\]+/gi;
  const OPEN_ID_RX = /https?:\/\/(?:www\.)?google\.com\/open\?id=[a-zA-Z0-9_-]{20,}[^\s\n"'<>\)\\]*/gi;

  function parseAllDocUrls(text) {
    const found = new Set();
    const addDoc = raw => {
      const u = cleanUrl(unwrap(raw));
      if (!isHttp(u)) return;
      // Normalise to canonical doc URL so all formats produce the same fileId
      found.add(normaliseDocUrl(u));
    };

    // Labelled patterns (Content Link:, Article Doc:, etc.)
    const LABEL_RX = [
      /Content\s*Link\s*[:\-]?\s*\n?\s*(https?:\/\/[^\s\n"'<>\)\\]+)/gi,
      /Content\s*(?:URL|Doc)\s*[:\-]?\s*\n?\s*(https?:\/\/[^\s\n"'<>\)\\]+)/gi,
      /Article\s*(?:Doc|Link|URL)\s*[:\-]?\s*\n?\s*(https?:\/\/[^\s\n"'<>\)\\]+)/gi,
      /Google\s*Doc\s*[:\-]?\s*\n?\s*(https?:\/\/[^\s\n"'<>\)\\]+)/gi,
      /\bDoc(?:ument)?\s*(?:URL|Link)?\s*[:\-]?\s*\n?\s*(https?:\/\/[^\s\n"'<>\)\\]+)/gi,
    ];
    for (const rx of LABEL_RX) {
      for (const m of text.matchAll(rx)) {
        if (m[1] && isGoogleDoc(m[1])) addDoc(m[1]);
      }
    }

    // Bare docs.google.com/document links
    for (const m of text.matchAll(/https?:\/\/docs\.google\.com\/document\/[^\s\n"'<>\)\\]+/gi))
      addDoc(m[0]);

    // google.com/open?id= links (the format shown in screenshot)
    for (const m of text.matchAll(OPEN_ID_RX)) addDoc(m[0]);

    // drive.google.com links
    for (const m of text.matchAll(DOC_URL_RX)) addDoc(m[0]);

    return [...found];
  }

  // ─── BULK ORDER BLOCK PARSER ──────────────────────────────────
  // For emails with multiple orders separated by --- or repeated Order ID:

  function parseBulkOrderBlocks(text) {
    // Split on "---" dividers OR on new "Order ID:" lines
    const parts = text.split(/(?:^|\n)\s*-{3,}\s*(?:\n|$)|(?=(?:^|\n)\s*Order\s+ID\s*:\s*#?\s*\d{4,})/im);
    return parts.map(p => p.trim()).filter(p => p.length > 50 && /Order\s+ID\s*:/i.test(p));
  }

  // ─── REPLY LINK EXTRACTOR ────────────────────────────────────
  // Extract live URLs and invoices from reply emails

  function extractReplyLinks(text) {
    const liveUrls = [], invoiceUrls = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const trim = line.trim();
      if (!isHttp(trim)) continue;
      const u = cleanUrl(unwrap(trim));
      if (!isHttp(u)) continue;
      if (isInvoice(u)) { invoiceUrls.push(u); continue; }
      if (!isSkipForLive(u)) liveUrls.push(u);
    }
    // Also match URLs embedded in text
    const seen = new Set([...liveUrls, ...invoiceUrls]);
    const urlRx = /https?:\/\/[^\s"'<>()\[\]{}\\\u200B\u00A0\n\r,;|]+/g;
    let m;
    while ((m = urlRx.exec(text)) !== null) {
      const u = cleanUrl(unwrap(m[0]));
      if (!isHttp(u) || seen.has(u)) continue;
      seen.add(u);
      if (isInvoice(u)) invoiceUrls.push(u);
      else if (!isSkipForLive(u)) liveUrls.push(u);
    }
    return { liveUrls, invoiceUrls };
  }

  // ─── CONFIDENCE SCORING ───────────────────────────────────────

  // Domain match + site-token/slug overlap. Doc URLs carry no usable slug
  // (the path is a random file ID), so same-domain bulk orders are
  // disambiguated later in the side panel using the doc title.
  function scorePairing(site, liveUrl) {
    let score = 0;
    if (site && domainsMatch(site, getHost(liveUrl))) score += 50;
    if (site) {
      const siteTokens = site.replace(/\./g, ' ').split(/[\s\-_]+/).filter(t => t.length > 2);
      score += Math.round(tokenOverlap(siteTokens, slugTokens(liveUrl)) * 30);
    }
    return score;
  }

  function scoreLabel(score) {
    if (score >= 60) return 'high';
    if (score >= 30) return 'medium';
    if (score > 0)   return 'low';
    return 'none';
  }

  // ─── MAIN SCAN ────────────────────────────────────────────────
  // CRITICAL DESIGN:
  // 1. Identify the FIRST email block (order notification from GPL)
  // 2. Parse all orders from it (single or bulk)
  // 3. Collect live links and invoice links from ALL emails (full thread)
  // 4. Match live links to orders by domain

  function scan() {
    if (!ctxOk()) return { orders: [], scannedAt: Date.now() };
    console.log('[GPL v27] Scanning', location.href);

    const allBlocks = getEmailBlocks();
    console.log('[GPL v27] Raw blocks:', allBlocks.length);

    // Collect all DOM links
    const seen = new Set(), allDomLinks = [];
    collectLinksDeep(document, seen, allDomLinks);

    // Categorize blocks
    const orderBlocks = [];  // blocks with order info (from first email)
    const replyBlocks = [];  // blocks with live links / replies

    // We want to separate the FIRST order email from replies.
    // Strategy: first block(s) that contain ORDER_KEYWORDS = order email(s)
    // Remaining blocks or blocks with REPLY_KEYWORDS = reply emails

    let foundFirstOrderBlock = false;
    for (const block of allBlocks) {
      const isOrder = looksLikeOrderEmail(block);
      const isReply = looksLikeReplyEmail(block);

      if (isOrder && !foundFirstOrderBlock) {
        foundFirstOrderBlock = true;
        orderBlocks.push(block);
      } else if (isOrder && foundFirstOrderBlock) {
        // Could be a forwarded copy, keep as potential reply too
        replyBlocks.push(block);
      } else if (isReply) {
        replyBlocks.push(block);
      } else {
        // Unknown blocks — check if they have live URLs
        replyBlocks.push(block);
      }
    }

    // If no order block found, use all blocks as order source
    const orderSource = orderBlocks.length > 0 ? orderBlocks.join('\n\n') : allBlocks.join('\n\n');
    const fullThreadText = allBlocks.join('\n\n');

    // ── EXTRACT ORDERS FROM FIRST EMAIL ONLY ──────────────────
    const orderIds = parseOrderIds(orderSource);
    const allDocUrls = parseAllDocUrls(orderSource);

    // Check if this is a bulk order email
    const hasBulkOrders = orderIds.length > 1 || allDocUrls.length > 1;

    let rawOrders = [];

    if (hasBulkOrders) {
      // Try to parse individual blocks
      const bulkBlocks = parseBulkOrderBlocks(orderSource);
      if (bulkBlocks.length > 1) {
        for (const block of bulkBlocks) {
          const ids = parseOrderIds(block);
          const docs = parseAllDocUrls(block);
          const sites = parseSite(block);
          rawOrders.push({
            orderId: ids[0] || orderIds[0] || null,
            publisherSite: sites[0] || null,
            docUrl: docs[0] || null,
          });
        }
      } else {
        // Multiple sites/docs in same email block
        const sites = parseSite(orderSource);
        const maxCount = Math.max(sites.length, allDocUrls.length, orderIds.length);
        for (let i = 0; i < maxCount; i++) {
          rawOrders.push({
            orderId: orderIds[i] || orderIds[0] || null,
            publisherSite: sites[i] || null,
            docUrl: allDocUrls[i] || null,
          });
        }
      }
    } else {
      // Single order
      const sites = parseSite(orderSource);
      rawOrders.push({
        orderId: orderIds[0] || null,
        publisherSite: sites[0] || null,
        docUrl: allDocUrls[0] || null,
      });
    }

    // Remove empty orders
    rawOrders = rawOrders.filter(o => o.publisherSite || o.docUrl || o.orderId);

    console.log('[GPL v27] Raw orders from first email:', rawOrders.length);

    // ── COLLECT LIVE LINKS FROM FULL THREAD ───────────────────
    const allLiveLinks = [], allInvoiceLinks = [];
    const urlSeen = new Set();

    // From DOM links
    for (const u of allDomLinks) {
      if (urlSeen.has(u)) continue;
      urlSeen.add(u);
      if (isInvoice(u)) allInvoiceLinks.push(u);
      else if (!isSkipForLive(u)) allLiveLinks.push(u);
    }

    // From text (full thread)
    const textLinks = extractTextUrls(fullThreadText, urlSeen);
    for (const u of textLinks) {
      if (isInvoice(u)) allInvoiceLinks.push(u);
      else if (!isSkipForLive(u)) allLiveLinks.push(u);
    }

    console.log('[GPL v27] Live links:', allLiveLinks.length, 'Invoice links:', allInvoiceLinks.length);

    // ── MATCH LIVE LINKS TO ORDERS ─────────────────────────────
    // Deduplicate invoice links (same PayPal URL repeated = same invoice)
    const uniqueInvoiceLinks = [...new Set(allInvoiceLinks)];

    // Score every order × live-link pair, then assign globally best-first.
    // The old per-order greedy loop let order #1 take whichever link it saw
    // first, even when that link scored higher for order #2.
    const pairs = [];
    rawOrders.forEach((o, oi) => {
      if (!o.publisherSite) return;
      for (const u of allLiveLinks) {
        const s = scorePairing(o.publisherSite, u);
        if (s > 0) pairs.push({ oi, u, s });
      }
    });
    pairs.sort((a, b) => b.s - a.s);

    const assignedLive = {};       // order index -> { u, s }
    const usedLiveUrls = new Set();
    for (const p of pairs) {
      if (assignedLive[p.oi] !== undefined || usedLiveUrls.has(p.u)) continue;
      assignedLive[p.oi] = { u: p.u, s: p.s };
      usedLiveUrls.add(p.u);
    }

    // An assignment is ambiguous when another same-domain link scored within
    // 15 points — domain/slug heuristics cannot tell them apart. The side
    // panel resolves these by comparing live slugs against the doc title.
    function liveIsAmbiguous(oi) {
      const a = assignedLive[oi];
      if (!a) return false;
      return pairs.some(p => p.oi === oi && p.u !== a.u &&
        domainsMatch(a.u, p.u) && (a.s - p.s) < 15);
    }

    const usedDocIds = new Set();

    const finalOrders = rawOrders.map((o, i) => {
      // Dedup by doc ID
      if (o.docUrl) {
        const docId = extractDocFileId(o.docUrl);
        if (docId) {
          if (usedDocIds.has(docId)) { o.docUrl = null; }
          else usedDocIds.add(docId);
        }
      }

      const assigned  = assignedLive[i] || null;
      const liveUrl   = assigned ? assigned.u : null;
      const matchScore = assigned ? assigned.s : 0;
      const ambiguous = liveIsAmbiguous(i);

      // Assign invoice (first one, or the one most recently shared)
      // All orders in same thread share the same invoice unless there's one per order
      const invoiceUrl = uniqueInvoiceLinks[i] || uniqueInvoiceLinks[0] || null;

      return {
        orderId:         o.orderId,
        publisherSite:   o.publisherSite,
        docUrl:          o.docUrl,
        liveUrl,
        invoiceUrl,
        matchScore,
        ambiguous,
        matchConfidence: ambiguous ? 'low' : scoreLabel(matchScore),
      };
    });

    // ── FINAL DEDUP ───────────────────────────────────────────
    // Remove complete duplicates (same site + same doc)
    const seen2 = new Set();
    const deduped = finalOrders.filter(o => {
      const key = `${rootDomain(o.publisherSite||'')}::${extractDocFileId(o.docUrl||'')||o.docUrl||''}`;
      if (seen2.has(key)) return false;
      seen2.add(key);
      return true;
    });

    console.log('[GPL v27] Final orders:', deduped.length,
      deduped.map(o => `${o.publisherSite||'?'} doc=${!!o.docUrl} live=${!!o.liveUrl}`));

    return {
      orders: deduped,
      debug: {
        totalBlocks: allBlocks.length,
        orderBlocks: orderBlocks.length,
        replyBlocks: replyBlocks.length,
        rawOrderCount: rawOrders.length,
        liveLinks: allLiveLinks.slice(0, 15),
        invoiceLinks: uniqueInvoiceLinks,
        textLength: fullThreadText.length,
        textSample: orderSource.slice(0, 500),
      },
      threadId:  getThreadId(),
      scannedAt: Date.now(),
    };
  }

  // ─── THREAD DETECTION & SCHEDULING ───────────────────────────

  function getThreadId() {
    const m = location.href.match(/conversations?[\/\#%2F]([a-zA-Z0-9\-]{8,})/);
    if (m) return m[1];
    const segs = location.pathname.replace(/\/$/, '').split('/');
    return segs[segs.length - 1] || location.href;
  }

  let _lastHref = location.href, _lastTid = getThreadId(), _timer = null, _lastRan = 0;

  function schedule(ms) {
    clearTimeout(_timer);
    _timer = setTimeout(() => {
      if (!ctxOk()) return;
      if (Date.now() - _lastRan < 500) { schedule(500); return; }
      _lastRan = Date.now();
      try { safeStorageSet({ oleData: scan() }); } catch(e) { console.error('[GPL v26]', e); }
    }, ms);
  }

  new MutationObserver(() => {
    if (!ctxOk()) return;
    if (location.href === _lastHref) return;
    _lastHref = location.href;
    const tid = getThreadId();
    if (tid === _lastTid) return;
    _lastTid = tid;
    safeStorageSet({ oleData: { orders: [], switching: true, scannedAt: Date.now() } });
    schedule(900);
  }).observe(document.documentElement, { childList: true, subtree: true });

  let _mc = 0;
  new MutationObserver(muts => {
    if (!ctxOk()) return;
    if (muts.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && (n.innerText || '').length > 80))
      && (++_mc <= 3 || _mc % 4 === 0)) schedule(1200);
  }).observe(document.body, { childList: true, subtree: true });

  schedule(1800);

  // ── PAYPAL INVOICE AMOUNT EXTRACTION ──────────────────────────

  function fetchUrlAsText(url) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = 15000;
      xhr.setRequestHeader('Accept', 'text/html,application/xhtml+xml,*/*');
      xhr.onload  = () => xhr.status >= 200 && xhr.status < 400
        ? resolve({ status: xhr.status, html: xhr.responseText })
        : reject(new Error(`HTTP ${xhr.status}`));
      xhr.onerror  = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Timeout'));
      xhr.send();
    });
  }

  function detectCurrency(str) {
    if (str.includes('€')) return 'EUR';
    if (str.includes('£')) return 'GBP';
    if (str.includes('₹')) return 'INR';
    return 'USD';
  }

  async function fetchPaypalAmount(invoiceUrl) {
    if (!invoiceUrl || !invoiceUrl.includes('paypal.com'))
      return { ok: false, error: 'Not a PayPal URL' };
    try {
      const { html } = await fetchUrlAsText(invoiceUrl);
      const jsonLd = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
      if (jsonLd) {
        try {
          const ld = JSON.parse(jsonLd[1]);
          const price = ld.totalPaymentDue?.price || ld.price || ld.amount;
          if (price) return { ok: true, amount: parseFloat(price), currency: ld.priceCurrency || 'USD', method: 'json-ld' };
        } catch {}
      }
      const dm = html.match(/(?:totalAmount|grand_total|amount_due)['":\s]+([0-9]+\.?[0-9]*)/i);
      if (dm) return { ok: true, amount: parseFloat(dm[1]), currency: 'USD', method: 'data-attr' };
      const totals = [...html.matchAll(/(?:Total\s*(?:Due|Amount)|Amount\s*Due|Invoice\s*Total)[^$€£₹0-9]*([€$£₹]?\s*[0-9,]+\.?[0-9]{0,2})/gi)];
      if (totals.length) {
        const amt = parseFloat(totals[0][1].replace(/[^\d.]/g, ''));
        if (!isNaN(amt)) return { ok: true, amount: amt, currency: detectCurrency(totals[0][1]), method: 'text-pattern' };
      }
      const amounts = [...html.matchAll(/\$\s*([0-9,]+\.[0-9]{2})/g)]
        .map(m => parseFloat(m[1].replace(/,/g, ''))).filter(n => !isNaN(n) && n > 0).sort((a, b) => b - a);
      if (amounts.length) return { ok: true, amount: amounts[0], currency: 'USD', method: 'largest-amount' };
      return { ok: false, error: 'Could not extract amount' };
    } catch(e) { return { ok: false, error: e.message }; }
  }

  // ── MESSAGE ROUTER ────────────────────────────────────────────
  if (ctxOk()) {
    chrome.runtime.onMessage.addListener((msg, _, respond) => {
      if (!ctxOk()) { respond({ ok:false, error:'Extension context invalidated' }); return false; }
      if (msg.action === 'scan') {
        try { const r = scan(); safeStorageSet({ oleData: r }); respond({ ok:true, ...r }); }
        catch(e) { respond({ ok:false, error:e.message, orders:[] }); }
        return true;
      }
      if (msg.action === 'fetchPaypalAmount') {
        fetchPaypalAmount(msg.invoiceUrl)
          .then(r => respond({ ok:true, ...r }))
          .catch(e => respond({ ok:false, error:e.message }));
        return true;
      }
      if (msg.action === 'ping') { respond({ ok:true, v:'22.0' }); return true; }
    });
  }

})();
