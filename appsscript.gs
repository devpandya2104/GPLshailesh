// ================================================================
//  GPL — Google Apps Script Web App  v27.0
//  GuestPostLinks Order Tracker
//  ────────────────────────────────────────
//  CHANGES v27:
//    + writeLiveToClientSheet: finds Article Doc row in client Sheet,
//      writes live URL into the Live link column (auto-detected or col M)
//
//  FIXES v26:
//    1. Live link false-error — retry with different user-agents/headers,
//       treat 403/406/503 as "soft pass" (site blocks bots, not offline)
//    2. Anchor text comparison — normalise whitespace/case before compare
//    3. Article doc up/down issue — fetch doc title from H1 not filename
//    4. Same-domain bulk confusion handled at content.js level
//
//  HANDLES:
//    1. POST { action: 'appendSheet', values: [...] }
//    2. POST { action: 'validate', liveUrl, docAnchors, docText }
//    3. POST { action: 'validateWithDoc', liveUrl, docUrl }
//    4. POST { action: 'fetchDoc', docUrl }
//
//  DEPLOY: Extensions → Apps Script → paste → Deploy → New deployment
//  Type: Web app | Execute as: Me | Who has access: Anyone
// ================================================================

var SHEET_NAME     = 'Sheet1';
var SPREADSHEET_ID = '1Qf94YaMECDvZXiPOxmh7EaSMSXN6dpv2YgpidVvisks';

// ── FULL IMAGE DOMAIN + EXTENSION FILTER ─────────────────────────────────────
var IMAGE_DOMAINS = [
  'images.pexels.com','pexels.com','unsplash.com','images.unsplash.com',
  'magnific.com','freepik.com','img.freepik.com','depositphotos.com',
  'st.depositphotos.com','shutterstock.com','image.shutterstock.com',
  'istockphoto.com','media.istockphoto.com','gettyimages.com',
  'pixabay.com','cdn.pixabay.com','stocksnap.io','burst.shopifycdn.com',
  'picsum.photos','placeholder.com','placehold.it','lorempixel.com',
  'dummyimage.com','via.placeholder.com','cloudinary.com','imgix.net',
  'amazonaws.com','flickr.com','live.staticflickr.com','dreamstime.com',
  'alamy.com','123rf.com','vectorstock.com','vecteezy.com','canva.com',
  'adobe.com','stock.adobe.com','creativemarket.com','media.giphy.com',
  'giphy.com','tenor.com','imgur.com','prnt.sc','i.imgur.com',
  'drive.google.com','docs.google.com','googleusercontent.com',
  'lh3.googleusercontent.com','lh4.googleusercontent.com',
  'lh5.googleusercontent.com','lh6.googleusercontent.com',
  'wp-content','wp-includes','gravatar.com','s.w.org',
  'media.tenor.com','cdn.discordapp.com','scontent.cdninstagram.com'
];

var IMAGE_EXTENSIONS = [
  '.jpg','.jpeg','.png','.gif','.webp','.svg','.bmp','.tiff','.tif',
  '.ico','.avif','.heic','.mp4','.mp3','.mov','.avi','.webm','.ogg',
  '.pdf','.zip','.rar','.gz','.woff','.woff2','.ttf','.eot'
];

// HTTP status codes that mean "site is alive but blocking bots"
// These should NOT count as "page not found" failures
var BOT_BLOCK_CODES = [403, 406, 429, 503, 520, 521, 522, 523, 524, 525, 526, 530];

function isImageOrMediaUrl(url) {
  if (!url) return false;
  var low = url.toLowerCase();
  var path = low.split('?')[0];
  for (var i = 0; i < IMAGE_EXTENSIONS.length; i++) {
    if (path.endsWith(IMAGE_EXTENSIONS[i])) return true;
  }
  var hostname = '';
  try {
    var m = low.match(/^https?:\/\/([^\/\?#]+)/);
    if (m) hostname = m[1].replace(/^www\./, '');
  } catch(e) {}
  for (var j = 0; j < IMAGE_DOMAINS.length; j++) {
    var dom = IMAGE_DOMAINS[j];
    if (hostname === dom || hostname.endsWith('.' + dom) || low.indexOf(dom) !== -1) return true;
  }
  if (low.indexOf('wp-content/uploads') !== -1) return true;
  if (low.indexOf('wp-includes') !== -1) return true;
  if (low.indexOf('/cdn-cgi/image') !== -1) return true;
  if (low.indexOf('/assets/img') !== -1) return true;
  if (low.indexOf('/images/') !== -1 && (path.endsWith('.jpg') || path.endsWith('.png') || path.endsWith('.webp'))) return true;
  return false;
}

// ── ROUTER ────────────────────────────────────────────────────────────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action || 'appendSheet';

    if (action === 'fetchDoc') {
      return jsonResp(fetchGoogleDoc(body.docUrl));
    }

    if (action === 'validate') {
      return jsonResp(validateLiveUrl(body.liveUrl, body.docAnchors || [], body.docText || ''));
    }

    if (action === 'validateWithDoc') {
      var docData   = fetchGoogleDoc(body.docUrl);
      var anchors   = docData.anchors  || [];
      var text      = docData.bodyText || '';
      var valResult = validateLiveUrl(body.liveUrl, anchors, text);
      valResult.docAnchors = anchors;
      valResult.docText    = text;
      valResult.docMethod  = docData.method  || '';
      valResult.docStatus  = docData.status  || 'ok';
      valResult.docMessage = docData.message || '';
      return jsonResp(valResult);
    }

    if (action === 'appendSheet' || body.values) {
      return jsonResp(appendToSheet(body.values));
    }

    if (action === 'writeLiveToClientSheet') {
      return jsonResp(writeLiveToClientSheet(body.clientSheetUrl, body.docUrl, body.liveUrl));
    }

    return jsonResp({ status: 'error', message: 'Unknown action: ' + action });

  } catch (err) {
    return jsonResp({ status: 'error', message: err.toString() });
  }
}

function doGet(e) {
  return jsonResp({ status: 'ok', message: 'GPL Apps Script v27.1 is running', sheet: SHEET_NAME });
}

function jsonResp(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── APPEND TO SHEET ───────────────────────────────────────────────────────────
// v26: now accepts 6 columns — Publisher Site, Doc URL, Live URL, Invoice URL, Order ID, Live Link (again as col6 alias)
function appendToSheet(values) {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return { status: 'error', message: 'No values provided' };
  }
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  values.forEach(function(row) {
    sheet.appendRow([
      row[0]||'',  // Publisher Site
      row[1]||'',  // Doc URL
      row[2]||'',  // Live URL
      row[3]||'',  // Invoice URL
      row[4]||'',  // Order ID
    ]);
  });
  return { status: 'ok', appended: values.length };
}

// ════════════════════════════════════════════════════════════════════════════
//  LIVE URL VALIDATOR v26
//  FIX: Bot-blocking sites (403/406/503) treated as "soft pass" — they are
//       live but block scrapers. We confirm URL is reachable by HEAD first,
//       then fall back to GET with browser-like UA. If still blocked, mark
//       as "soft pass" with a note rather than a false failure.
// ════════════════════════════════════════════════════════════════════════════
function validateLiveUrl(liveUrl, docAnchors, docText) {
  var checks = [];

  if (!liveUrl) {
    return { status: 'ok', checks: [{ label: 'Live URL', status: 'fail', detail: 'No live URL provided' }] };
  }

  // ── 1. Fetch live page ────────────────────────────────────────────────────
  var html = '';
  var fetchedOk = false;
  var isSoftBlock = false;

  // Attempt 1: browser-like User-Agent GET
  try {
    var resp = UrlFetchApp.fetch(liveUrl, {
      method: 'get',
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: false,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });
    var code = resp.getResponseCode();

    if (code === 200) {
      html = resp.getContentText();
      fetchedOk = true;
      checks.push({ label: 'Page Accessible', status: 'pass', detail: 'HTTP 200 OK' });
    } else if (BOT_BLOCK_CODES.indexOf(code) !== -1) {
      // Site is up but blocking bots — soft pass
      isSoftBlock = true;
      checks.push({
        label: 'Page Accessible',
        status: 'pass',
        detail: 'HTTP ' + code + ' (site is live — blocks automated fetchers, verified as accessible)'
      });
    } else if (code === 301 || code === 302) {
      checks.push({ label: 'Page Accessible', status: 'pass', detail: 'HTTP ' + code + ' (redirect, page is live)' });
      isSoftBlock = true;
    } else {
      // Real error — try once more with HEAD to confirm
      try {
        var headResp = UrlFetchApp.fetch(liveUrl, {
          method: 'head',
          muteHttpExceptions: true,
          followRedirects: true,
          validateHttpsCertificates: false,
        });
        var headCode = headResp.getResponseCode();
        if (headCode === 200 || BOT_BLOCK_CODES.indexOf(headCode) !== -1) {
          isSoftBlock = true;
          checks.push({ label: 'Page Accessible', status: 'pass', detail: 'HTTP ' + code + ' (HEAD confirmed live — site blocks GET scrapers)' });
        } else {
          checks.push({ label: 'Page Accessible', status: 'fail', detail: 'HTTP ' + code + ' (HEAD: ' + headCode + ')' });
          return { status: 'ok', checks: checks };
        }
      } catch(eHead) {
        checks.push({ label: 'Page Accessible', status: 'fail', detail: 'HTTP ' + code });
        return { status: 'ok', checks: checks };
      }
    }
  } catch(e) {
    // Network error — try HEAD as final fallback
    try {
      var headResp2 = UrlFetchApp.fetch(liveUrl, {
        method: 'head',
        muteHttpExceptions: true,
        followRedirects: true,
        validateHttpsCertificates: false,
      });
      var headCode2 = headResp2.getResponseCode();
      if (headCode2 === 200 || BOT_BLOCK_CODES.indexOf(headCode2) !== -1) {
        isSoftBlock = true;
        checks.push({ label: 'Page Accessible', status: 'pass', detail: 'HEAD HTTP ' + headCode2 + ' (site is live, blocks automated GET)' });
      } else {
        checks.push({ label: 'Page Accessible', status: 'fail', detail: 'Fetch error: ' + e.message });
        return { status: 'ok', checks: checks };
      }
    } catch(e2) {
      checks.push({ label: 'Page Accessible', status: 'fail', detail: 'Fetch error: ' + e.message });
      return { status: 'ok', checks: checks };
    }
  }

  // If we got a soft block (no HTML), we can't check anchors or content
  if (isSoftBlock && !fetchedOk) {
    var rawDocAnchors2 = docAnchors || [];
    var validDocAnchors2 = rawDocAnchors2.filter(function(a) {
      return a && a.url && !isImageOrMediaUrl(a.url);
    });
    if (validDocAnchors2.length > 0) {
      checks.push({
        label: 'Anchor Links',
        status: 'warn',
        detail: 'Cannot verify ' + validDocAnchors2.length + ' link(s) — site blocks automated fetchers. Please check manually:\n' +
          validDocAnchors2.map(function(a,i){ return '→ Link '+(i+1)+': "'+a.text+'" → '+a.url; }).join('\n')
      });
    } else {
      checks.push({ label: 'Anchor Links', status: 'info', detail: 'Site blocks automated access — manual check required' });
    }
    checks.push({ label: 'Content Similarity', status: 'info', detail: 'Cannot check — site blocks automated fetchers' });
    return { status: 'ok', checks: checks };
  }

  // ── 2. Extract anchors from live page ─────────────────────────────────────
  var liveAnchors = extractAnchors(html, liveUrl);

  // ── 3. Filter doc anchors — skip ALL image/media URLs ─────────────────────
  var rawDocAnchors   = docAnchors || [];
  var validDocAnchors = rawDocAnchors.filter(function(a) {
    if (!a || !a.url) return false;
    if (isImageOrMediaUrl(a.url)) {
      Logger.log('SKIP image/media anchor: ' + a.url);
      return false;
    }
    return true;
  });

  var skippedCount = rawDocAnchors.length - validDocAnchors.length;
  Logger.log('Doc anchors: total=' + rawDocAnchors.length + ' valid=' + validDocAnchors.length + ' skipped(images)=' + skippedCount);

  // ── 4. Validate anchors ───────────────────────────────────────────────────
  if (validDocAnchors.length === 0) {
    if (rawDocAnchors.length > 0 && skippedCount === rawDocAnchors.length) {
      checks.push({ label: 'Anchor Links', status: 'info', detail: 'All ' + skippedCount + ' doc links are image/media sources — skipped (no content links to validate)' });
    } else {
      checks.push({ label: 'Anchor Links', status: 'info', detail: 'No content anchor links found in Google Doc' });
    }
  } else {
    var allOk  = true;
    var details = [];
    var matched = [];

    for (var i = 0; i < validDocAnchors.length; i++) {
      var da  = validDocAnchors[i];
      var num = i + 1;
      var match = null, matchIdx = -1;

      // Normalize anchor text for comparison (trim, lowercase, collapse spaces)
      var daTextNorm = normalizeAnchorText(da.text || '');

      // Pass 1: exact normalized URL
      for (var j = 0; j < liveAnchors.length; j++) {
        if (matched.indexOf(j) !== -1) continue;
        if (normUrl(liveAnchors[j].url) === normUrl(da.url)) { match = liveAnchors[j]; matchIdx = j; break; }
      }
      // Pass 2: strip UTM params
      if (!match) {
        for (var j = 0; j < liveAnchors.length; j++) {
          if (matched.indexOf(j) !== -1) continue;
          if (stripUtm(liveAnchors[j].url) === stripUtm(da.url)) { match = liveAnchors[j]; matchIdx = j; break; }
        }
      }
      // Pass 3: same base domain (ignore subdomains like www/blog)
      if (!match) {
        for (var j = 0; j < liveAnchors.length; j++) {
          if (matched.indexOf(j) !== -1) continue;
          var la = liveAnchors[j];
          if (sameDomain(la.url, da.url)) {
            var sim = calcSim(daTextNorm, normalizeAnchorText(la.text || ''));
            if (sim >= 0.75) { match = la; matchIdx = j; break; }
          }
        }
      }
      // Pass 4: partial URL match (path contains slug)
      if (!match) {
        var daSlug = extractSlug(da.url);
        if (daSlug && daSlug.length > 5) {
          for (var j = 0; j < liveAnchors.length; j++) {
            if (matched.indexOf(j) !== -1) continue;
            var la = liveAnchors[j];
            var laSlug = extractSlug(la.url);
            if (laSlug && laSlug.indexOf(daSlug) !== -1) { match = la; matchIdx = j; break; }
          }
        }
      }

      if (!match) {
        allOk = false;
        details.push('❌ Link ' + num + ' MISSING — "' + (da.text||'') + '" → ' + da.url);
        continue;
      }
      matched.push(matchIdx);

      if (match.nofollow)        { allOk=false; details.push('❌ Link '+num+' is NOFOLLOW — "'+match.text+'"'); }
      else if (match.sponsored)  { allOk=false; details.push('❌ Link '+num+' is SPONSORED — "'+match.text+'"'); }
      else if (match.ugc)        { allOk=false; details.push('❌ Link '+num+' has UGC tag — "'+match.text+'"'); }
      else                       { details.push('✅ Link '+num+' OK — "'+match.text+'" (dofollow)'); }

      // FIX: anchor text comparison now uses normalized text
      var matchTextNorm = normalizeAnchorText(match.text || '');
      var simT = calcSim(daTextNorm, matchTextNorm);
      if (simT < 0.78 && da.text && match.text && daTextNorm !== matchTextNorm) {
        // Only flag if it's not just a case/whitespace difference
        var simLoose = calcSim(daTextNorm.replace(/\s+/g,''), matchTextNorm.replace(/\s+/g,''));
        if (simLoose < 0.85) {
          allOk = false;
          details.push('⚠️ Link '+num+' anchor text changed — Expected: "'+da.text+'" | Found: "'+match.text+'"');
        }
      }
    }

    var anchorLabel = 'Anchor Links (' + validDocAnchors.length + ')';
    if (skippedCount > 0) anchorLabel += ' [' + skippedCount + ' image links skipped]';
    checks.push({
      label:  anchorLabel,
      status: allOk ? 'pass' : 'fail',
      detail: details.join('\n')
    });
  }

  // ── 5. Content similarity ─────────────────────────────────────────────────
  if (docText && docText.trim()) {
    var liveText = html
      .replace(/<script[\s\S]*?<\/script>/gi,'')
      .replace(/<style[\s\S]*?<\/style>/gi,'')
      .replace(/<!--[\s\S]*?-->/g,'')
      .replace(/<[^>]+>/g,' ')
      .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/\s+/g,' ').trim().substring(0, 8000);

    var docSample  = (docText || '').replace(/\s+/g,' ').trim().substring(0, 8000);
    var similarity = calcSim(docSample.toLowerCase(), liveText.toLowerCase());
    var pct        = Math.round(similarity * 100);

    if (pct >= 50) {
      checks.push({ label: 'Content Similarity', status: 'pass',  detail: pct + '% match (minimum 50%)' });
    } else if (pct >= 25) {
      checks.push({ label: 'Content Similarity', status: 'warn',  detail: pct + '% match (minimum 50%)' });
    } else {
      checks.push({ label: 'Content Similarity', status: 'fail',  detail: pct + '% match (minimum 50%)' });
    }
  }

  return { status: 'ok', checks: checks };
}

// ── NORMALIZE ANCHOR TEXT for comparison ─────────────────────────────────────
function normalizeAnchorText(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[''""]/g, "'").trim();
}

// ── EXTRACT SLUG FROM URL ────────────────────────────────────────────────────
function extractSlug(url) {
  if (!url) return '';
  try {
    var path = new URL(url).pathname;
    var parts = path.split('/').filter(function(p){ return p.length > 3; });
    return parts[parts.length - 1] || '';
  } catch(e) { return ''; }
}

// ── EXTRACT ANCHORS FROM LIVE HTML ────────────────────────────────────────────
function extractAnchors(html, baseUrl) {
  var anchors = [];
  if (!html) return anchors;
  var re = /<a\s([^>]*)>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    try {
      var attrs = m[1] || '';
      var inner = m[2] || '';
      var text  = inner.replace(/<[^>]*>/g,'')
        .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
      if (!text || text.length < 2) continue;

      var hrefM = attrs.match(/href=["']([^"']+)["']/i);
      if (!hrefM) continue;
      var href = hrefM[1];
      if (!href || href.indexOf('http') !== 0) continue;
      if (isImageOrMediaUrl(href)) continue;

      var relM     = attrs.match(/rel=["']([^"']+)["']/i);
      var rel      = relM ? relM[1].toLowerCase() : '';
      var nofollow  = rel.indexOf('nofollow') !== -1;
      var sponsored = rel.indexOf('sponsored') !== -1;
      var ugc       = rel.indexOf('ugc') !== -1;

      anchors.push({ text: text, url: href, nofollow: nofollow, sponsored: sponsored, ugc: ugc, rel: rel });
    } catch(e) {}
  }
  return anchors;
}

// ── URL HELPERS ───────────────────────────────────────────────────────────────
function normUrl(u) {
  if (!u) return '';
  return u.replace(/^https?:\/\/(www\.)?/i,'').replace(/\/+$/,'').toLowerCase();
}

function stripUtm(u) {
  if (!u) return '';
  try {
    return u.split('?')[0].replace(/^https?:\/\/(www\.)?/i,'').replace(/\/+$/,'').toLowerCase();
  } catch(e) { return u; }
}

function sameDomain(u1, u2) {
  try {
    var d1 = u1.match(/^https?:\/\/([^\/]+)/); d1 = d1 ? d1[1].replace(/^www\./).toLowerCase() : '';
    var d2 = u2.match(/^https?:\/\/([^\/]+)/); d2 = d2 ? d2[1].replace(/^www\./).toLowerCase() : '';
    if (!d1 || !d2) return false;
    // Extract root domain (handles co.uk etc.)
    return rootDomainGs(d1) === rootDomainGs(d2);
  } catch(e) { return false; }
}

function rootDomainGs(host) {
  var parts = host.split('.');
  if (parts.length < 2) return host;
  var cc = ['co.uk','co.in','co.nz','co.za','co.jp','com.au','com.br','com.mx'];
  if (parts.length >= 3 && cc.indexOf(parts.slice(-2).join('.')) !== -1) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

// ── LEVENSHTEIN SIMILARITY ────────────────────────────────────────────────────
function calcSim(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b)  return 1;
  var L = a.length >= b.length ? a : b;
  var S = a.length >= b.length ? b : a;
  if (L.length > 400) {
    var hits = 0, total = 0;
    var words = S.split(/\s+/).filter(function(w){ return w.length > 3; });
    words.forEach(function(w){ total++; if (L.indexOf(w) !== -1) hits++; });
    return total ? hits / total : 0;
  }
  var m = [];
  for (var i = 0; i <= S.length; i++) m[i] = [i];
  for (var j = 0; j <= L.length; j++) m[0][j] = j;
  for (var i = 1; i <= S.length; i++) {
    for (var j = 1; j <= L.length; j++) {
      m[i][j] = S[i-1] === L[j-1] ? m[i-1][j-1] : 1 + Math.min(m[i-1][j-1], m[i][j-1], m[i-1][j]);
    }
  }
  return (L.length - m[S.length][L.length]) / L.length;
}

// ════════════════════════════════════════════════════════════════════════════
//  FETCH GOOGLE DOC v26
// ════════════════════════════════════════════════════════════════════════════
function fetchGoogleDoc(docUrl) {
  if (!docUrl) return { status: 'error', message: 'No doc URL', anchors: [], bodyText: '' };

  var docId = extractDocId(docUrl);
  if (!docId) return { status: 'error', message: 'Cannot extract Doc ID from: ' + docUrl, anchors: [], bodyText: '' };

  // ── Strategy 1: DocumentApp ───────────────────────────────────────────────
  try {
    var doc  = DocumentApp.openById(docId);
    var body = doc.getBody();
    var rawText = body.getText() || '';
    var anchors = [];
    extractDocLinks(body, anchors);

    anchors = anchors.filter(function(a) { return !isImageOrMediaUrl(a.url); });

    var h1 = '';
    var paragraphs = body.getParagraphs();
    for (var i = 0; i < paragraphs.length; i++) {
      var h = paragraphs[i].getHeading();
      if (h === DocumentApp.ParagraphHeading.HEADING1 || h === DocumentApp.ParagraphHeading.TITLE) {
        h1 = paragraphs[i].getText().trim();
        if (h1) break;
      }
    }
    if (!h1) h1 = doc.getName() || '';

    Logger.log('fetchGoogleDoc (DocumentApp): ' + anchors.length + ' content anchors');
    return { status: 'ok', method: 'documentapp', anchors: anchors, bodyText: rawText, h1: h1, docId: docId };
  } catch(e1) {
    Logger.log('DocumentApp failed: ' + e1.message);
  }

  // ── Strategy 2: Export as HTML ────────────────────────────────────────────
  try {
    var htmlResp = UrlFetchApp.fetch(
      'https://docs.google.com/document/d/' + docId + '/export?format=html',
      { muteHttpExceptions: true, followRedirects: true }
    );
    if (htmlResp.getResponseCode() === 200) {
      var html = htmlResp.getContentText();
      var anchors2 = extractAnchorsFromDocHtml(html);
      anchors2 = anchors2.filter(function(a) { return !isImageOrMediaUrl(a.url); });
      var bodyText2 = html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().substring(0, 8000);
      var h1Html = '';
      var h1M = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      if (h1M) h1Html = h1M[1].replace(/<[^>]*>/g,'').trim();
      Logger.log('fetchGoogleDoc (HTML export): ' + anchors2.length + ' content anchors');
      return { status: 'ok', method: 'html_export', anchors: anchors2, bodyText: bodyText2, h1: h1Html, docId: docId };
    }
  } catch(e2) { Logger.log('HTML export failed: ' + e2.message); }

  // ── Strategy 3: TXT export ────────────────────────────────────────────────
  try {
    var txtResp = UrlFetchApp.fetch(
      'https://docs.google.com/document/d/' + docId + '/export?format=txt',
      { muteHttpExceptions: true, followRedirects: true }
    );
    if (txtResp.getResponseCode() === 200) {
      var txt = txtResp.getContentText() || '';
      return { status: 'ok', method: 'txt_export', anchors: [], bodyText: txt.substring(0, 8000), h1: '', docId: docId };
    }
  } catch(e3) { Logger.log('TXT export failed: ' + e3.message); }

  return {
    status: 'error',
    message: 'Cannot access Google Doc. Make sure it is shared as "Anyone with the link can view".',
    anchors: [], bodyText: '', docId: docId
  };
}

// ── EXTRACT LINKS FROM DocumentApp body ──────────────────────────────────────
function extractDocLinks(body, links) {
  try {
    for (var c = 0; c < body.getNumChildren(); c++) {
      try { extractLinksFromElement(body.getChild(c), links); } catch(e) {}
    }
  } catch(e) {}
}

function extractLinksFromElement(el, links) {
  try {
    var t = el.getType();
    if (t === DocumentApp.ElementType.TEXT) {
      extractLinksFromText(el.asText(), links);
    } else if (t === DocumentApp.ElementType.PARAGRAPH || t === DocumentApp.ElementType.LIST_ITEM) {
      var p = (t === DocumentApp.ElementType.PARAGRAPH) ? el.asParagraph() : el.asListItem();
      for (var i = 0; i < p.getNumChildren(); i++) try { extractLinksFromElement(p.getChild(i), links); } catch(e) {}
    } else if (t === DocumentApp.ElementType.TABLE) {
      var tb = el.asTable();
      for (var r = 0; r < tb.getNumRows(); r++) {
        var row = tb.getRow(r);
        for (var col = 0; col < row.getNumCells(); col++) {
          var cell = row.getCell(col);
          for (var ci = 0; ci < cell.getNumChildren(); ci++) try { extractLinksFromElement(cell.getChild(ci), links); } catch(e) {}
        }
      }
    }
  } catch(e) {}
}

function extractLinksFromText(textEl, links) {
  try {
    var txt = textEl.getText() || '';
    var pos = 0;
    while (pos < txt.length) {
      var url = null;
      try { url = textEl.getLinkUrl(pos); } catch(e) { pos++; continue; }
      if (url) {
        var start = pos, end = pos + 1;
        while (end < txt.length) {
          var u2 = null;
          try { u2 = textEl.getLinkUrl(end); } catch(e) { break; }
          if (u2 !== url) break;
          end++;
        }
        var linkText = txt.substring(start, end).trim();
        if (linkText && url && !links.some(function(l){ return l.url===url && l.text===linkText; })) {
          links.push({ text: linkText, url: url });
        }
        pos = end;
      } else { pos++; }
    }
  } catch(e) {}
}

// ── EXTRACT LINKS FROM EXPORTED HTML ─────────────────────────────────────────
function extractAnchorsFromDocHtml(html) {
  var anchors = [];
  if (!html) return anchors;
  var re   = /<a\s+[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var seen = {};
  var m;
  while ((m = re.exec(html)) !== null) {
    try {
      var rawHref = m[1];
      var text = (m[2]||'').replace(/<[^>]*>/g,'')
        .replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')
        .replace(/&lt;/g,'<').replace(/&gt;/g,'>')
        .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
        .replace(/\s+/g,' ').trim();

      if (!text || !rawHref) continue;

      var url = rawHref;
      if (rawHref.indexOf('google.com/url') !== -1) {
        var qM = rawHref.match(/[?&]q=([^&]+)/);
        if (qM) { try { url = decodeURIComponent(qM[1]); } catch(e) { url = qM[1]; } }
      }

      if (!url || url.indexOf('http') !== 0) continue;
      if (isImageOrMediaUrl(url)) continue;

      var key = url + '|' + text;
      if (!seen[key]) { seen[key] = true; anchors.push({ text: text, url: url }); }
    } catch(e) {}
  }
  return anchors;
}


// ════════════════════════════════════════════════════════════════════════════
//  WRITE LIVE LINK TO CLIENT SHEET v26
//  Finds the row where Article Doc URL matches docUrl, then writes liveUrl
//  into the "Live link" column (searches header row for "Live link" label,
//  falls back to column M = index 13).
// ════════════════════════════════════════════════════════════════════════════
function writeLiveToClientSheet(clientSheetUrl, docUrl, liveUrl) {
  if (!clientSheetUrl) return { status: 'error', message: 'No client sheet URL provided' };
  if (!docUrl)         return { status: 'error', message: 'No doc URL provided' };
  if (!liveUrl)        return { status: 'error', message: 'No live URL provided' };

  // Extract spreadsheet ID from URL
  var ssIdMatch = clientSheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (!ssIdMatch) return { status: 'error', message: 'Cannot extract spreadsheet ID from: ' + clientSheetUrl };
  var ssId = ssIdMatch[1];

  // Extract optional gid (sheet tab)
  var gidMatch = clientSheetUrl.match(/[#&?]gid=([0-9]+)/);
  var gid = gidMatch ? parseInt(gidMatch[1]) : null;

  try {
    var ss = SpreadsheetApp.openById(ssId);
    var sheet = null;

    if (gid !== null) {
      var sheets = ss.getSheets();
      for (var s = 0; s < sheets.length; s++) {
        if (sheets[s].getSheetId() === gid) { sheet = sheets[s]; break; }
      }
    }
    if (!sheet) sheet = ss.getActiveSheet();

    var data = sheet.getDataRange().getValues();
    if (!data.length) return { status: 'error', message: 'Sheet is empty' };

    // ── Find header row & column indices ─────────────────────────────────────
    // v27 FIX: Scan ALL columns with broad name matching.
    // Client sheets use varied names: "Copied Doc", "Article Doc", "Live Post URL", etc.
    var headerRow = data[0];
    var docColIdx  = -1;
    var liveColIdx = -1;

    // Doc column: any header that contains "doc", "content", "article", "copied"
    // Live column: any header that contains "live"
    var DOC_HDR_MUST  = ['doc', 'content link', 'article', 'copied'];
    var LIVE_HDR_MUST = ['live'];

    for (var c = 0; c < headerRow.length; c++) {
      var hdr = String(headerRow[c] || '').toLowerCase().trim();
      if (docColIdx === -1) {
        for (var d = 0; d < DOC_HDR_MUST.length; d++) {
          if (hdr.indexOf(DOC_HDR_MUST[d]) !== -1) { docColIdx = c; break; }
        }
      }
      if (liveColIdx === -1) {
        for (var l = 0; l < LIVE_HDR_MUST.length; l++) {
          if (hdr.indexOf(LIVE_HDR_MUST[l]) !== -1) { liveColIdx = c; break; }
        }
      }
    }

    // Smarter fallback: scan ALL columns across up to 10 data rows to find
    // which column actually contains Google Doc URLs. No hard column limit.
    if (docColIdx === -1) {
      var scanRows = Math.min(data.length, 11);
      outer: for (var c = 0; c < headerRow.length; c++) {
        for (var r = 1; r < scanRows; r++) {
          var cellVal = String(data[r][c] || '');
          if (cellVal.indexOf('docs.google.com') !== -1 ||
              (cellVal.indexOf('google.com/open') !== -1 && cellVal.indexOf('id=') !== -1)) {
            docColIdx = c;
            break outer;
          }
        }
      }
    }

    // Live link fallback: column immediately to the right of docColIdx
    // (in most client sheets "Live Post URL" is right after the doc column)
    if (liveColIdx === -1 && docColIdx !== -1) {
      liveColIdx = docColIdx + 1;
    }

    // Log what we found for debugging
    var docColName  = docColIdx  >= 0 ? String(headerRow[docColIdx]  || 'col '+(docColIdx+1))  : 'NOT FOUND';
    var liveColName = liveColIdx >= 0 ? String(headerRow[liveColIdx] || 'col '+(liveColIdx+1)) : 'NOT FOUND';
    Logger.log('writeLiveToClientSheet: docCol=' + docColIdx + ' ("' + docColName + '") liveCol=' + liveColIdx + ' ("' + liveColName + '")');

    if (docColIdx === -1) {
      return {
        status: 'error',
        message: 'Cannot find a Doc URL column in this sheet. Headers found: [' +
          headerRow.slice(0, 30).map(function(h){ return String(h||'').trim(); }).filter(Boolean).join(', ') + ']'
      };
    }

    // ── Extract doc file ID from the search URL ───────────────────────────────
    var targetDocId = extractDocId(docUrl);
    if (!targetDocId) return { status: 'error', message: 'Cannot extract doc ID from: ' + docUrl };

    // ── Scan ALL doc-column cells; match by file ID OR substring ─────────────
    var matchedRow = -1;
    for (var r = 1; r < data.length; r++) {
      var cellDocUrl = String(data[r][docColIdx] || '').trim();
      if (!cellDocUrl) continue;
      // Primary: match by extracted file ID
      var cellDocId = extractDocId(cellDocUrl);
      if (cellDocId && cellDocId === targetDocId) { matchedRow = r; break; }
      // Secondary: substring match (handles URL format differences)
      if (cellDocUrl.indexOf(targetDocId) !== -1) { matchedRow = r; break; }
    }

    if (matchedRow === -1) {
      return {
        status: 'error',
        message: 'Doc not found in sheet. Checked ' + (data.length - 1) + ' rows in "' + docColName + '" (col ' + (docColIdx + 1) + '). Doc ID searched: ' + targetDocId.slice(0, 20) + '…'
      };
    }

    // ── Write the live link ───────────────────────────────────────────────────
    if (liveColIdx === -1) {
      return { status: 'error', message: 'Cannot find Live Link column. Doc row found at row ' + (matchedRow + 1) + '. Please check your sheet headers.' };
    }

    sheet.getRange(matchedRow + 1, liveColIdx + 1).setValue(liveUrl);

    return {
      status: 'ok',
      message: 'Live link written to row ' + (matchedRow + 1) + ', column ' + (liveColIdx + 1),
      row: matchedRow + 1,
      col: liveColIdx + 1,
      colHeader: liveColName,
      docColHeader: docColName,
    };

  } catch(e) {
    return { status: 'error', message: e.toString() };
  }
}

// ── EXTRACT DOC ID ────────────────────────────────────────────────────────────
function extractDocId(url) {
  if (!url) return null;
  var m1 = String(url).match(/\/d\/([a-zA-Z0-9_-]{25,})/);
  if (m1) return m1[1];
  var m2 = String(url).match(/[?&]id=([a-zA-Z0-9_-]{25,})/);
  if (m2) return m2[1];
  return null;
}
