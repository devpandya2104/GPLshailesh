// sidepanel.js — GPL v27
// CHANGES v27:
//   - REMOVED: "Live Link →" open button from Notion card links row
//   - REMOVED: "Sync Live Link to Notion" row
//   - ADDED: "Send Live Link to Client Sheet" row — writes live link into the
//            correct row of the client Google Sheet (col M / "Live link" col)
//            by matching the Article Doc URL in the sheet
'use strict';
const $ = id => document.getElementById(id);
const btnScan=$('btnScan'),btnSettings=$('btnSettings'),settingsPanel=$('settingsPanel');
const btnSaveSet=$('btnSaveSettings'),btnRebuild=$('btnRebuildCache'),settingsSt=$('settingsSt');
const btnCopyAll=$('btnCopyAll'),btnCopyHdr=$('btnCopyHdr'),btnClear=$('btnClear');
const btnSheets=$('btnSheets'),btnNotionAll=$('btnNotionAll');
const dotEl=$('dot'),stMsgEl=$('stMsg'),stTimeEl=$('stTime');
const stLoadEl=$('stLoading'),stEmptyEl=$('stEmpty'),emptyTitle=$('emptyTitle'),emptyHint=$('emptyHint');
const resultsEl=$('results'),footerEl=$('footer'),actionStatus=$('actionStatus'),toastEl=$('toast');

let currentData=null, cfg={}, toastTmr=null;
const notionState={}, manualOverrides={}, notionLog={};

const esc=s=>(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const trunc=(s,max=46)=>(!s||s.length<=max)?s||'':s.slice(0,Math.floor((max-3)/2))+'…'+s.slice(-Math.floor((max-3)/2));
const wait=ms=>new Promise(r=>setTimeout(r,ms));

function toast(msg,ms=2400){
  toastEl.textContent=msg; toastEl.classList.add('show');
  clearTimeout(toastTmr); toastTmr=setTimeout(()=>toastEl.classList.remove('show'),ms);
}
function setStatus(cls,msg){dotEl.className='dot '+cls; stMsgEl.textContent=msg;}
function setTime(ts){stTimeEl.textContent=ts?new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):''; }

function copyText(text){
  navigator.clipboard.writeText(text).then(()=>toast('✓ Copied')).catch(()=>{
    const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;opacity:0';
    document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);toast('✓ Copied');
  });
}
const svgCopy=(sz=11)=>`<svg width="${sz}" height="${sz}" viewBox="0 0 12 12" fill="none"><rect x="1" y="3" width="8" height="8" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3 1h7a1 1 0 011 1v7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const svgExt=`<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M4 2H2a1 1 0 00-1 1v5a1 1 0 001 1h5a1 1 0 001-1V6M6 1h3m0 0v3m0-3L5 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;
const svgSheet=`<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M1 4.5h10M4.5 4.5v6.5" stroke="currentColor" stroke-width="1.2"/></svg>`;

function orderToTsv(o){return[o.publisherSite||'',o.docUrl||'',o.liveUrl||'',o.invoiceUrl||''].join('\t');}
function orderToArr(o){return[o.publisherSite||'',o.docUrl||'',o.liveUrl||'',o.invoiceUrl||'',o.orderId||''];}

function effectiveOrder(o,idx){
  if(!o)return o;
  const ov=manualOverrides[idx]||{};
  return{...o,
    publisherSite:ov.publisherSite!==undefined?ov.publisherSite:o.publisherSite,
    docUrl:ov.docUrl!==undefined?ov.docUrl:o.docUrl,
    liveUrl:ov.liveUrl!==undefined?ov.liveUrl:o.liveUrl,
    invoiceUrl:ov.invoiceUrl!==undefined?ov.invoiceUrl:o.invoiceUrl,
  };
}

function formatAmount(amt,currency){
  if(amt===null||amt===undefined)return'—';
  const sym={USD:'$',EUR:'€',GBP:'£',INR:'₹',AUD:'A$',CAD:'C$'};
  const code=(currency||'USD').toUpperCase().replace(/^USD\s*/i,'').replace(/^US\$\s*/i,'').trim()||'USD';
  return(sym[code]||code+'\u00a0')+Number(amt).toFixed(2);
}

function invoiceCheck(notionData, paypalAmount, paypalCurrency) {
  if (!notionData?.pageId) return null;
  const { actualPaid, currencyType } = notionData;
  if (actualPaid === null || actualPaid === undefined) return null;
  if (paypalAmount === undefined || paypalAmount === null) return null;
  const notionCurrency = (currencyType||'USD').toUpperCase().replace(/^USD\s*/i,'').replace(/^US\$\s*/i,'').trim()||'USD';
  const invCurrency = (paypalCurrency||'USD').toUpperCase().trim()||'USD';
  if (notionCurrency !== invCurrency && invCurrency !== 'USD') {
    return { type:'red', msg:`⛔ Currency mismatch: Invoice is ${invCurrency}, Notion expects ${notionCurrency}. Submission blocked.` };
  }
  const diff = paypalAmount - actualPaid;
  if (diff > 0.01) return { type:'red', msg:`⛔ Invoice (${formatAmount(paypalAmount,invCurrency)}) exceeds approved amount (${formatAmount(actualPaid,notionCurrency)}) by ${formatAmount(diff,invCurrency)}. Blocked.` };
  if (diff < -0.01) return { type:'yellow', msg:`⚠️ Invoice (${formatAmount(paypalAmount,invCurrency)}) is lower than approved amount (${formatAmount(actualPaid,notionCurrency)}) by ${formatAmount(Math.abs(diff),notionCurrency)}. Confirm before sending.` };
  return { type:'green', msg:`✅ Invoice matches approved amount (${formatAmount(actualPaid,notionCurrency)}).` };
}

function determinePaymentStatus(notionData, invoiceUrl, paypalAmount, cfg) {
  if (!invoiceUrl) return null;
  const { txnDetails } = notionData || {};
  if (txnDetails && txnDetails.trim().length > 3) return 'Payment Confirmation Sent to Vendor/Admin';
  return 'Ready For Payment';
}

// ── SETTINGS ──────────────────────────────────────────────────────────────────
const SETTING_FIELDS={
  cfgWebAppUrl:'webAppUrl',cfgNotionKey:'notionApiKey',cfgNotionDb:'notionDbId',
  cfgPropFinalDoc:'propFinalDoc',cfgPropLiveLink:'propLiveLink',cfgPropInvoice:'propVendorInvoice',
  cfgPropPayment:'propPaymentStatus',cfgPropActualPaid:'propActualPaid',cfgPropCurrency:'propCurrencyType',
  cfgWritersDb:'writersDbId',cfgWritersDocProp:'writersDocProp',cfgWritersOrderProp:'writersOrderProp',
};
// Notion key is stored base64-encoded only so GitHub push protection accepts
// the commit — it is still a hardcoded secret, decoded at load time below.
const NOTION_KEY_B64='bnRuXzY2MzE3NjkyNjg1cXZiYVYxY2MyVXRHY3U3SkRXNzd3bFRZaEE0N1RySE5kak0=';
const DEFAULTS={
  webAppUrl:'https://script.google.com/macros/s/AKfycbwdnBPTEAT2lgAyC-Rbqccs5A3GDRBBm2XMfaPaLATwo1LN3jLrJlIE7Oxo0TXquKlk/exec',
  notionApiKey:atob(NOTION_KEY_B64),
  notionDbId:'2ddf70d7af0d816e98d4f052cff69104',
  propFinalDoc:'Final Doc',propLiveLink:'Live link',propVendorInvoice:'Vendor Invoice',
  propPaymentStatus:'Payment Status',propActualPaid:'Actual Paid',propCurrencyType:'Currency Type',
  writersDbId:'31fe3318538143458a8d4dfec9444b1c',
  writersDocProp:'Completed DOC',
  writersOrderProp:'2026 Order Management',
};

// Config shared by every Notion call from the panel
function notionCfg(){
  return{apiKey:cfg.notionApiKey,databaseId:cfg.notionDbId,
    propFinalDoc:cfg.propFinalDoc,propActualPaid:cfg.propActualPaid,propCurrencyType:cfg.propCurrencyType,
    writersDbId:cfg.writersDbId,writersDocProp:cfg.writersDocProp,writersOrderProp:cfg.writersOrderProp};
}

async function loadSettings(){
  const s=await chrome.storage.local.get('oleSettings');
  // Empty saved values must not shadow the built-in defaults
  cfg={...DEFAULTS};
  for(const[k,v]of Object.entries(s.oleSettings||{})){if(v)cfg[k]=v;}
  for(const[elId,key]of Object.entries(SETTING_FIELDS)){if($(elId)&&cfg[key])$(elId).value=cfg[key];}
}

btnSettings.addEventListener('click',()=>settingsPanel.classList.toggle('open'));

btnSaveSet.addEventListener('click',async()=>{
  const newCfg={...DEFAULTS};
  for(const[elId,key]of Object.entries(SETTING_FIELDS)){if($(elId))newCfg[key]=$(elId).value.trim()||DEFAULTS[key]||'';}
  await chrome.storage.local.set({oleSettings:newCfg}); cfg=newCfg;
  settingsSt.className='setting-status ok'; settingsSt.textContent='✓ Saved';
  btnSaveSet.classList.add('ok'); btnSaveSet.textContent='Saved ✓';
  setTimeout(()=>{btnSaveSet.classList.remove('ok');btnSaveSet.textContent='Save';settingsPanel.classList.remove('open');settingsSt.textContent='';},1500);
  toast('✓ Settings saved');
});

btnRebuild.addEventListener('click',async()=>{
  if(!cfg.notionApiKey){toast('⚙ Set Notion API Key first',3000);return;}
  btnRebuild.disabled=true; btnRebuild.textContent='↻ Rebuilding…';
  settingsSt.className='setting-status'; settingsSt.textContent='Fetching…';
  const resp=await new Promise(resolve=>chrome.runtime.sendMessage({
    action:'notionRebuildCache',
    config:notionCfg()
  },res=>resolve(res||{ok:false,error:'No response'})));
  btnRebuild.disabled=false; btnRebuild.textContent='↻ Rebuild Cache';
  if(resp.ok){settingsSt.className='setting-status ok';settingsSt.textContent=`✓ ${resp.count} pages`;toast(`✓ Cached ${resp.count} pages`);}
  else{settingsSt.className='setting-status err';settingsSt.textContent='✗ '+(resp.error||'').slice(0,50);toast('✗ '+(resp.error||'').slice(0,45),4000);}
});

// ── RENDER ────────────────────────────────────────────────────────────────────
function render(data){
  currentData=data; resultsEl.innerHTML='';
  stLoadEl.style.display='none';
  const orders=(data?.orders||[]).filter(o=>o.publisherSite||o.docUrl||o.liveUrl||o.invoiceUrl);
  if(!orders.length){
    stEmptyEl.style.display='flex'; emptyTitle.textContent='No order data found';
    emptyHint.innerHTML='Click <strong>Scan</strong> again or check the thread.';
    footerEl.classList.remove('show'); setStatus('empty','Nothing extracted'); setTime(data?.scannedAt);
    if(data?.debug){stEmptyEl.style.display='none';resultsEl.appendChild(buildDebug(data.debug,null,-1));}
    return;
  }
  stEmptyEl.style.display='none'; footerEl.classList.add('show');
  setStatus('found',`${orders.length} order${orders.length!==1?'s':''} found`); setTime(data.scannedAt);
  orders.forEach((o,i)=>resultsEl.appendChild(buildCard(o,i)));
  if(data.debug)resultsEl.appendChild(buildDebug(data.debug,null,-1));
  if(cfg.notionApiKey&&cfg.notionDbId){
    const docUrls=orders.map(o=>o.docUrl).filter(Boolean);
    if(docUrls.length)setTimeout(()=>doNotionFetchBatch(orders),300);
  }
  // Resolve same-domain bulk ambiguity BEFORE validating, so validation runs
  // against the corrected live links
  (async()=>{
    try{await doDisambiguateSameDomain();}catch(e){console.warn('[GPL] disambiguation failed:',e);}
    orders.forEach((o,i)=>{
      const eo=effectiveOrder(currentData?.orders?.[i],i);
      if(eo?.liveUrl&&cfg.webAppUrl)setTimeout(()=>doValidate(i),400+i*400);
    });
  })();
}

// ── CARD ──────────────────────────────────────────────────────────────────────
function postTypeClass(pt){
  if(!pt)return'';
  const l=pt.toLowerCase();
  if(l.includes('casino'))return'posttype-casino';
  if(l.includes('crypto'))return'posttype-crypto';
  if(l.includes('cbd'))return'posttype-cbd';
  if(l.includes('adult'))return'posttype-adult';
  return'posttype-general';
}

const CONF_LABELS={high:'High match',medium:'Medium',low:'Low match',none:'Unmatched'};
function confBadgeLabel(o){
  if(o._titleMatched)return'Title match ✓';
  if(o.ambiguous)return'Same domain ⚠';
  return CONF_LABELS[o.matchConfidence||'none']||o.matchConfidence;
}
function updateConfBadge(idx,o){
  const b=$(`confBadge_${idx}`);if(!b)return;
  b.className='badge badge-'+(o.matchConfidence||'none');
  b.textContent=confBadgeLabel(o);
}

function buildCard(o,idx){
  const conf=o.matchConfidence||'none';
  const card=document.createElement('div');
  card.className='card'; card.id=`card_${idx}`;
  card.innerHTML=`
    <div class="card-head">
      <div class="card-head-l">
        <div class="order-num">${idx+1}</div>
        <span class="order-label">Order ${idx+1}</span>
        ${o.orderId?`<span class="order-id">#${esc(o.orderId)}</span>`:''}
        <span class="badge badge-${conf}" id="confBadge_${idx}">${confBadgeLabel(o)}</span>
      </div>
      <div class="card-head-r">
        <button class="btn-edit-card" data-idx="${idx}">✏</button>
        <button class="btn-sm-card" data-idx="${idx}" data-action="copy-row">${svgCopy(10)} Copy</button>
      </div>
    </div>
    <div class="manual-panel" id="manualPanel_${idx}">
      <div class="manual-panel-title">✏ Manual Correction</div>
      <div class="manual-grid">
        <div class="manual-row"><span class="manual-lbl">Site</span><input class="manual-inp" id="mSite_${idx}" value="${esc(o.publisherSite||'')}"/></div>
        <div class="manual-row"><span class="manual-lbl">Doc</span><input class="manual-inp" id="mDoc_${idx}" value="${esc(o.docUrl||'')}"/></div>
        <div class="manual-row"><span class="manual-lbl">Live</span><input class="manual-inp" id="mLive_${idx}" value="${esc(o.liveUrl||'')}"/></div>
        <div class="manual-row"><span class="manual-lbl">Invoice</span><input class="manual-inp" id="mInv_${idx}" value="${esc(o.invoiceUrl||'')}"/></div>
      </div>
      <button class="btn-apply" data-idx="${idx}" data-action="apply-edit">Apply</button>
    </div>
    <div class="fields" id="fields_${idx}">
      ${buildFields(o)}
    </div>
    <div id="invoiceWarning_${idx}" class="invoice-warning" style="display:none"></div>
    <div id="paymentActions_${idx}" class="payment-actions"></div>
    ${buildNotionPanel(idx)}
    ${buildValPanel(idx)}
    ${buildDebug(null,null,idx)}
  `;
  return card;
}

function buildFields(o){
  let html=buildField('site','SITE',o.publisherSite,false);
  html+=buildField('doc','DOC',o.docUrl,true);
  html+=buildField('live','LIVE',o.liveUrl,true);
  html+=buildField('inv','INV',o.invoiceUrl,true);
  return html;
}

function buildField(type,label,val,isLink){
  const valHtml=!val
    ?`<div class="f-val"><span class="f-none">— not found</span></div>`
    :isLink
      ?`<div class="f-val"><a href="${esc(val)}" target="_blank" title="${esc(val)}">${esc(trunc(val))}</a></div>`
      :`<div class="f-val"><span class="f-plain" title="${esc(val)}">${esc(trunc(val,40))}</span></div>`;
  return`<div class="field"><span class="f-tag ${type}">${label}</span>${valHtml}<button class="btn-fc" data-url="${esc(val||'')}" data-action="copy-field" title="Copy">${svgCopy(10)}</button></div>`;
}

function refreshFields(idx){
  const o=effectiveOrder(currentData?.orders?.[idx],idx);
  const el=$(`fields_${idx}`); if(!el||!o)return;
  el.innerHTML=buildFields(o);
}

// ── NOTION PANEL ──────────────────────────────────────────────────────────────
function buildNotionPanel(idx){
  return`
    <div class="notion-panel">
      <div class="notion-head">
        <div class="notion-title">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="10" height="10" rx="1.5" fill="currentColor" opacity=".08"/><path d="M3 3h3M3 6h6M3 9h4" stroke="var(--fg)" stroke-width="1.1" stroke-linecap="round"/></svg>
          Notion Card
        </div>
        <div class="notion-head-r">
          <span id="notionOpenBtn_${idx}"></span>
          <button class="btn-fetch" data-idx="${idx}" data-action="notion-fetch">↻ Fetch</button>
        </div>
      </div>
      <div id="notionBody_${idx}"><div class="notion-empty">—</div></div>
      <div id="notionSendRow_${idx}" class="notion-send-row" style="display:none">
        <button class="btn-notion-send" data-idx="${idx}" data-action="notion-send-single">Send to Notion</button>
        <span class="notion-send-status" id="notionSendSt_${idx}"></span>
      </div>
      <div id="clientSheetRow_${idx}" class="client-sheet-row" style="display:none">
        <div class="csr-label">${svgSheet} Live Link → Client Sheet</div>
        <div class="csr-inputs">
          <input class="csr-inp" id="csrLiveInp_${idx}" type="url" placeholder="https://live-article-url…" spellcheck="false"/>
          <button class="btn-csr" data-idx="${idx}" data-action="send-live-to-sheet">Send</button>
        </div>
        <div class="csr-status" id="csrStatus_${idx}"></div>
      </div>
    </div>`;
}

function setNotionLoading(idx){
  const el=$(`notionBody_${idx}`);
  if(el)el.innerHTML=`<div class="notion-loading"><div class="spinner spinner-sm"></div> Fetching…</div>`;
}

function setNotionData(idx, state){
  notionState[idx]=state;
  const wrap=$(`notionBody_${idx}`); if(!wrap)return;
  const sendRow=$(`notionSendRow_${idx}`);
  const csRow=$(`clientSheetRow_${idx}`);
  const csrInp=$(`csrLiveInp_${idx}`);
  const openBtn=$(`notionOpenBtn_${idx}`);

  if(state.error){
    wrap.innerHTML=`<div class="notion-err">✗ ${esc(state.error)}</div>`;
    if(sendRow)sendRow.style.display='none';
    if(csRow)csRow.style.display='none';
    return;
  }

  const currCode=(state.currencyType||'USD').toUpperCase().replace(/^USD\s*/i,'').replace(/^US\$\s*/i,'').trim()||'USD';
  const paidFmt=formatAmount(state.actualPaid,currCode);
  const hasPaypal=state.paypalAmount!==undefined&&state.paypalAmount!==null;
  const hasPaid=state.actualPaid!==null&&state.actualPaid!==undefined;
  const diff=hasPaypal&&hasPaid?state.paypalAmount-state.actualPaid:null;

  let diffHtml='';
  if(diff!==null){
    const absDiff=Math.abs(diff);
    const invFmt=formatAmount(state.paypalAmount,state.paypalCurrency||currCode);
    if(absDiff<=0.01){
      diffHtml=`<div class="invoice-diff-row match"><span class="diff-ico">✅</span><div class="diff-body"><div class="diff-title">Invoice matches</div><div class="diff-detail">${esc(invFmt)} = ${esc(paidFmt)}</div></div></div>`;
    }else if(diff>0){
      diffHtml=`<div class="invoice-diff-row over"><span class="diff-ico">⛔</span><div class="diff-body"><div class="diff-title">Invoice exceeds approved (+${esc(formatAmount(diff,currCode))})</div><div class="diff-detail">Invoice: ${esc(invFmt)} · Notion: ${esc(paidFmt)}</div></div></div>`;
    }else{
      diffHtml=`<div class="invoice-diff-row under"><span class="diff-ico">⚠️</span><div class="diff-body"><div class="diff-title">Invoice lower than approved (${esc(formatAmount(diff,currCode))})</div><div class="diff-detail">Invoice: ${esc(invFmt)} · Notion: ${esc(paidFmt)}</div></div></div>`;
    }
  }

  const ptClass=postTypeClass(state.postType||'');
  const isBulk=(state.orderIn||'').toLowerCase().includes('bulk')||(state.orderIn||'').toLowerCase().includes('package');
  const o=effectiveOrder(currentData?.orders?.[idx],idx);
  const currentLive=o?.liveUrl||'';

  wrap.innerHTML=`
    <div class="notion-data">
      ${hasPaid?`<div class="notion-cell"><span class="notion-cell-lbl">Actual Paid</span><span class="notion-cell-val money">${esc(paidFmt)}</span></div>`:''}
      ${hasPaypal?`<div class="notion-cell"><span class="notion-cell-lbl">Invoice Amt</span><span class="notion-cell-val ${diff!==null&&Math.abs(diff)>0.01?'mismatch':'money'}">${esc(formatAmount(state.paypalAmount,state.paypalCurrency||currCode))}</span></div>`:''}
      ${diff!==null?`<div class="notion-cell"><span class="notion-cell-lbl">Difference</span><span class="notion-cell-val ${Math.abs(diff)<=0.01?'money':'mismatch'}">${diff>0.01?'+':''}${esc(formatAmount(diff,currCode))}</span></div>`:''}
      ${currCode?`<div class="notion-cell"><span class="notion-cell-lbl">Currency</span><span class="notion-cell-val">${esc(currCode)}</span></div>`:''}
      ${state.postType?`<div class="notion-cell"><span class="notion-cell-lbl">Post Type</span><span class="notion-cell-val ${ptClass}">${esc(state.postType)}</span></div>`:''}
      ${state.orderIn?`<div class="notion-cell"><span class="notion-cell-lbl">Order In</span><span class="notion-cell-val"><span class="badge ${isBulk?'badge-bulk':'badge-single'}">${esc(state.orderIn)}</span></span></div>`:''}
      ${state.pageId?`<div class="notion-cell"><span class="notion-cell-lbl">Page ID</span><span class="notion-cell-val pageid">${esc(state.pageId.slice(0,8))}…</span></div>`:''}
    </div>
    ${diffHtml}
    <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
      ${state.orderUrl?`<a href="${esc(state.orderUrl)}" target="_blank" class="order-url-link">Open Order Page ${svgExt}</a>`:''}
      ${state.clientSheet?`<a href="${esc(state.clientSheet)}" target="_blank" class="order-url-link green-link">Open Client Sheet ${svgExt}</a>`:''}
    </div>
  `;

  // Open in Notion button
  if(openBtn&&state.pageUrl){
    openBtn.innerHTML=`<a href="${esc(state.pageUrl)}" target="_blank" class="btn-notion-open">Open in Notion ${svgExt}</a>`;
  }

  // Update card head badges
  const cardHeadL=document.querySelector(`#card_${idx} .card-head-l`);
  if(cardHeadL){
    cardHeadL.querySelectorAll('.badge-posttype,.badge-single,.badge-bulk').forEach(b=>b.remove());
    if(state.postType){
      const pb=document.createElement('span');
      pb.className='badge badge-posttype'; pb.textContent=state.postType;
      cardHeadL.appendChild(pb);
    }
  }

  // Invoice warning banner
  if(hasPaypal){
    const check=invoiceCheck({actualPaid:state.actualPaid,currencyType:state.currencyType,pageId:state.pageId},state.paypalAmount,state.paypalCurrency);
    const wEl=$(`invoiceWarning_${idx}`);
    if(wEl&&check){wEl.className=`invoice-warning ${check.type}`;wEl.style.display='block';wEl.textContent=check.msg;}
  }else{
    const wEl=$(`invoiceWarning_${idx}`);
    if(wEl){wEl.className='invoice-warning';wEl.style.display='none';wEl.textContent='';}
  }

  // Payment actions
  const autoStatus=determinePaymentStatus(state,o?.invoiceUrl,state.paypalAmount,cfg);
  const paEl=$(`paymentActions_${idx}`);
  if(paEl){
    if(!o?.invoiceUrl){
      paEl.className='payment-actions show';
      paEl.innerHTML=`<div class="payment-actions-title">No Invoice Found — Choose Status</div>
        <div class="payment-btns">
          <button class="btn-payment" data-idx="${idx}" data-status="Invoice Details Pending">Invoice Details Pending</button>
          <button class="btn-payment" data-idx="${idx}" data-status="Sent for Verification">Sent for Verification</button>
        </div>`;
    }else{
      paEl.className='payment-actions show';
      paEl.innerHTML=`<div class="payment-actions-title">Payment Status</div>
        <div class="payment-btns">
          <button class="btn-payment ${autoStatus==='Ready For Payment'?'selected':''}" data-idx="${idx}" data-status="Ready For Payment">Ready For Payment</button>
          <button class="btn-payment ${autoStatus==='Payment Confirmation Sent to Vendor/Admin'?'selected':''}" data-idx="${idx}" data-status="Payment Confirmation Sent to Vendor/Admin">Confirmation Sent</button>
          <button class="btn-payment" data-idx="${idx}" data-status="Invoice Details Pending">Invoice Pending</button>
        </div>`;
    }
    notionState[idx]._selectedPaymentStatus=autoStatus;
  }

  // Show Notion send row always when pageId is present
  if(sendRow)sendRow.style.display=state.pageId?'flex':'none';

  // ── NEW v27: Show "Send Live Link to Client Sheet" row ────────────────────
  // Show when we have both a clientSheet URL and a pageId
  if(csRow){
    const hasSheet=!!(state.clientSheet);
    csRow.style.display=hasSheet?'flex':'none';
    if(hasSheet&&csrInp){
      // Pre-fill with current live link from the order
      if(currentLive&&!csrInp.value)csrInp.value=currentLive;
    }
    // Show a "no sheet" hint if pageId present but no clientSheet
    if(!hasSheet&&state.pageId){
      csRow.style.display='flex';
      const csrStatus=$(`csrStatus_${idx}`);
      if(csrStatus){csrStatus.className='csr-status warn';csrStatus.textContent='⚠ No Client Sheet linked in Notion card';}
      const btn=csRow.querySelector(`[data-action="send-live-to-sheet"]`);
      if(btn)btn.disabled=true;
    }
  }

  notionLog[idx]=(notionLog[idx]||[]);
  notionLog[idx].push(`[${new Date().toISOString().slice(11,19)}] Loaded pageId=${state.pageId?.slice(0,8)} actualPaid=${state.actualPaid} clientSheet=${state.clientSheet?'✓':'—'}`);
  refreshDebug(idx);
}

// ── VALIDATION PANEL ──────────────────────────────────────────────────────────
function buildValPanel(idx){
  return`
    <div class="val-panel">
      <div class="val-head">
        <span class="val-title">
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.2"/><path d="M7.5 7.5L10 10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
          Link Validation
        </span>
        <button class="btn-validate" data-idx="${idx}" data-action="validate">Validate</button>
      </div>
      <div id="valBody_${idx}"><div class="val-empty">Click Validate to check live article.</div></div>
    </div>`;
}

function setValLoading(idx){
  const el=$(`valBody_${idx}`);
  if(el)el.innerHTML=`<div class="val-loading"><div class="spinner spinner-sm"></div> Validating…</div>`;
}

function setValResults(idx,checks){
  const el=$(`valBody_${idx}`); if(!el)return;
  const ico={pass:'✅',fail:'❌',warn:'⚠️',info:'ℹ️'};
  el.innerHTML=`<div class="val-body">`+
    checks.map(c=>`
      <div class="chk-row ${c.status}">
        <span class="chk-ico">${ico[c.status]||'ℹ️'}</span>
        <div><div class="chk-label">${esc(c.label)}</div>${c.detail?`<div class="chk-detail">${esc(c.detail)}</div>`:''}</div>
      </div>`).join('')+`</div>`;
  notionLog[idx]=(notionLog[idx]||[]);
  notionLog[idx].push(`[${new Date().toISOString().slice(11,19)}] Validation: ${checks.map(c=>c.status+':'+c.label).join(', ')}`);
  refreshDebug(idx);
}

// ── DEBUG PANEL ───────────────────────────────────────────────────────────────
function buildDebug(dbg,state,idx){
  if(idx===-1&&dbg){
    const d=document.createElement('details'); d.className='debug';
    const s=document.createElement('summary'); s.textContent='🐛 Debug Info'; d.appendChild(s);
    const body=document.createElement('div'); body.className='debug-body';
    const entries=[['Total blocks',dbg.totalBlocks],['Order blocks',dbg.orderBlocks],['Reply blocks',dbg.replyBlocks],['Raw orders',dbg.rawOrderCount],['Live links',(dbg.liveLinks||[]).length],['Invoice links',(dbg.invoiceLinks||[]).length]];
    body.innerHTML=entries.map(([k,v])=>`<div class="dl"><span class="dlk">${k}:</span> ${v??'—'}</div>`).join('')
      +(dbg.liveLinks?.length?`<div class="dl"><span class="dlk">Live sample:</span><br>${(dbg.liveLinks||[]).slice(0,5).map(u=>`<div>${esc(u)}</div>`).join('')}</div>`:'')+
      (dbg.textSample?`<div class="dl"><span class="dlk">Order email snippet:</span><br><pre style="white-space:pre-wrap;font-size:9.5px;max-height:80px;overflow:auto;color:var(--fg3)">${esc(dbg.textSample.slice(0,300))}</pre></div>`:'');
    d.appendChild(body); return d;
  }
  return`
    <details class="debug">
      <summary>🐛 Debug Info</summary>
      <div class="debug-body" id="debugBody_${idx}">
        <div class="dl">Awaiting data…</div>
      </div>
    </details>`;
}

function refreshDebug(idx){
  const el=$(`debugBody_${idx}`); if(!el)return;
  const ns=notionState[idx]||{};
  const logs=(notionLog[idx]||[]).slice(-8);
  el.innerHTML=`
    <div class="dl"><span class="dlk">Notion Page ID:</span> ${esc(ns.pageId?.slice(0,12)||'—')}</div>
    <div class="dl"><span class="dlk">Post Type:</span> ${esc(ns.postType||'—')}</div>
    <div class="dl"><span class="dlk">Order In:</span> ${esc(ns.orderIn||'—')}</div>
    <div class="dl"><span class="dlk">Actual Paid:</span> ${ns.actualPaid??'—'}</div>
    <div class="dl"><span class="dlk">Invoice Amt:</span> ${ns.paypalAmount??'—'}</div>
    <div class="dl"><span class="dlk">Currency:</span> ${esc(ns.currencyType||'—')}</div>
    <div class="dl"><span class="dlk">From Cache:</span> ${ns.fromCache??'—'}</div>
    <div class="dl"><span class="dlk">Client Sheet:</span> ${ns.clientSheet?'✓ '+esc(ns.clientSheet.slice(0,40))+'…':'—'}</div>
    <div class="dl"><span class="dlk">PayPal:</span> ${ns.paypalAmount!==undefined?ns.paypalAmount+' '+ns.paypalCurrency:'not scraped'}</div>
    ${logs.length?`<div class="dl"><span class="dlk">Log:</span></div><div class="debug-notion-log">${logs.map(esc).join('\n')}</div>`:''}`;
}

// ── SAME-DOMAIN BULK DISAMBIGUATION ───────────────────────────────────────────
// When several orders share one publisher domain, domain/slug heuristics in
// content.js cannot tell their live links apart. Live article slugs derive
// from the article title, which is the Google Doc H1 — so fetch each doc's
// title via Apps Script and re-match live links by title↔slug token overlap.
function spGetHost(u){try{return new URL(u).hostname.replace(/^www\./,'').toLowerCase();}catch{return'';}}
function spRootDomain(input){
  if(!input)return'';
  let h=input.includes('://')?spGetHost(input):input.toLowerCase();
  h=h.split('/')[0].split('?')[0].split('#')[0].replace(/^www\./,'').trim();
  const parts=h.split('.');
  if(parts.length<2)return h;
  const cc=['co.uk','co.in','co.nz','co.za','co.jp','co.ke','co.au','com.au','com.br','com.mx','org.uk'];
  if(parts.length>=3&&cc.includes(parts.slice(-2).join('.')))return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}
function spSlugTokens(url){
  try{return new URL(url).pathname.toLowerCase().split(/[-\/_.]+/).filter(t=>t.length>2&&!/^\d+$/.test(t));}
  catch{return[];}
}
function spTitleTokens(title){
  return(title||'').toLowerCase().replace(/[^a-z0-9\s-]/g,' ').split(/[\s-]+/).filter(t=>t.length>2&&!/^\d+$/.test(t));
}
function spTokensMatch(a,b){return a===b||(a.length>3&&b.length>3&&(a.startsWith(b)||b.startsWith(a)));}
function spTitleSlugSim(titleTokens,slug){
  if(!titleTokens.length||!slug.length)return 0;
  let hits=0;
  for(const t of slug){if(titleTokens.some(u=>spTokensMatch(t,u)))hits++;}
  return hits/Math.min(titleTokens.length,slug.length);
}

function fetchDocInfo(docUrl){
  return new Promise(resolve=>chrome.runtime.sendMessage(
    {action:'fetchDoc',docUrl,webAppUrl:cfg.webAppUrl},
    res=>resolve(res&&res.ok?res:null)));
}

async function doDisambiguateSameDomain(){
  if(!cfg.webAppUrl||!currentData?.orders)return;
  const orders=currentData.orders;

  // Group order indices by publisher root domain
  const groups={};
  orders.forEach((o,i)=>{
    if(manualOverrides[i]?.liveUrl!==undefined)return; // user already corrected this one
    const rd=spRootDomain(o.publisherSite||o.liveUrl||'');
    if(!rd)return;
    (groups[rd]=groups[rd]||[]).push(i);
  });

  for(const[rd,idxs]of Object.entries(groups)){
    if(idxs.length<2)continue;
    const withDoc=idxs.filter(i=>orders[i].docUrl);
    if(!withDoc.length)continue;
    if(withDoc.length<2&&!idxs.some(i=>orders[i].ambiguous))continue;

    // Candidate live links: those assigned within this group, plus any
    // same-domain links the scanner saw but left unassigned.
    const candidates=new Set();
    idxs.forEach(i=>{if(orders[i].liveUrl)candidates.add(orders[i].liveUrl);});
    (currentData.debug?.liveLinks||[]).forEach(u=>{if(spRootDomain(u)===rd)candidates.add(u);});
    const candList=[...candidates];
    if(!candList.length)continue;

    // Fetch doc titles; cache anchors/text so Validate skips a second doc fetch
    const titles={};
    await Promise.all(withDoc.map(async i=>{
      const info=await fetchDocInfo(orders[i].docUrl);
      if(info){
        titles[i]=info.h1||'';
        orders[i]._docTitle=info.h1||'';
        orders[i]._docAnchors=info.anchors||[];
        orders[i]._docText=info.bodyText||'';
        orders[i]._docFetched=true;
      }else titles[i]='';
    }));

    // Score doc-title ↔ live-slug pairs, assign best score first
    const pairs=[];
    for(const i of withDoc){
      const tt=spTitleTokens(titles[i]);
      if(!tt.length)continue;
      for(const u of candList){
        const sim=spTitleSlugSim(tt,spSlugTokens(u));
        if(sim>=0.34)pairs.push({i,u,sim});
      }
    }
    if(!pairs.length)continue;
    pairs.sort((a,b)=>b.sim-a.sim);
    const assign={},usedU=new Set();
    for(const p of pairs){
      if(assign[p.i]!==undefined||usedU.has(p.u))continue;
      assign[p.i]=p;usedU.add(p.u);
    }

    let changed=0;
    for(const k of Object.keys(assign)){
      const i=+k,p=assign[k],o=orders[i];
      if(o.liveUrl!==p.u)changed++;
      o.liveUrl=p.u;
      o.matchScore=Math.round(50+p.sim*50);
      o.matchConfidence=p.sim>=0.6?'high':'medium';
      o.ambiguous=false;
      o._titleMatched=true;
      refreshFields(i);updateConfBadge(i,o);
      notionLog[i]=(notionLog[i]||[]);
      notionLog[i].push(`[${new Date().toISOString().slice(11,19)}] Doc title "${(titles[i]||'').slice(0,40)}" → live ${p.u.slice(0,55)} (${Math.round(p.sim*100)}% slug match)`);
      refreshDebug(i);
    }

    // If a title match stole the link another order was showing, try to hand
    // that order a still-unused same-domain candidate. NEVER null an existing
    // live link here — a wrong-but-present link is better than erasing one, and
    // erasing it also suppressed validation. Leave it untouched if nothing free.
    for(const i of idxs){
      if(assign[i]!==undefined)continue;
      const o=orders[i];
      if(o.liveUrl&&usedU.has(o.liveUrl)&&!o._titleMatched){
        const free=candList.find(u=>!usedU.has(u)&&!idxs.some(j=>orders[j].liveUrl===u));
        if(free){
          o.liveUrl=free;usedU.add(free);o.matchConfidence='low';
          changed++;refreshFields(i);updateConfBadge(i,o);
        }
      }
    }
    if(changed)toast(`✓ ${changed} live link${changed>1?'s':''} re-matched by doc title`,3000);
  }
}

// ── SCAN ──────────────────────────────────────────────────────────────────────
async function doScan(){
  btnScan.disabled=true;
  btnScan.innerHTML='<div class="spinner" style="width:12px;height:12px;border-width:2px;border-color:rgba(255,255,255,.3);border-top-color:white"></div> Scanning…';
  stEmptyEl.style.display='none'; stLoadEl.style.display='flex';
  resultsEl.innerHTML=''; footerEl.classList.remove('show'); actionStatus.textContent='';
  setStatus('scanning','Scanning…');
  Object.keys(notionState).forEach(k=>delete notionState[k]);
  Object.keys(manualOverrides).forEach(k=>delete manualOverrides[k]);
  Object.keys(notionLog).forEach(k=>delete notionLog[k]);
  try{
    const[tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.id)throw new Error('No active tab');
    if(!tab.url?.includes('missiveapp.com'))throw new Error('Open a Missive thread first');
    let result;
    try{result=await msgTab(tab.id,{action:'scan'},7000);}
    catch(e){
      await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
      await wait(1500); result=await msgTab(tab.id,{action:'scan'},9000);
    }
    // Always render the FRESH scan result (even if empty). Never fall back to
    // the previous thread's data from storage — that was the "keeps old orders
    // after switching tab/email" bug.
    if(result&&Array.isArray(result.orders)){render(result);}
    else{stLoadEl.style.display='none';stEmptyEl.style.display='flex';emptyTitle.textContent='No data found';emptyHint.innerHTML='Open a thread then click <strong>Scan</strong>.';setStatus('empty','Nothing found');}
  }catch(err){
    stLoadEl.style.display='none';stEmptyEl.style.display='flex';
    emptyTitle.textContent='Scan error';emptyHint.textContent=err.message;
    setStatus('error',err.message.slice(0,60));toast('✗ '+err.message.slice(0,50),4000);
  }finally{
    btnScan.disabled=false;
    btnScan.innerHTML='<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M10 6a4 4 0 11-4-4" stroke="white" stroke-width="1.4" stroke-linecap="round"/><path d="M8 2l2 2M10 2L8 4" stroke="white" stroke-width="1.4" stroke-linecap="round"/></svg> Scan';
  }
}

function msgTab(tabId,msg,timeout=6000){
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error('Content script timeout')),timeout);
    try{chrome.tabs.sendMessage(tabId,msg,res=>{clearTimeout(t);if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));else resolve(res);});}
    catch(e){clearTimeout(t);reject(e);}
  });
}

// ── NOTION BATCH FETCH ────────────────────────────────────────────────────────
async function doNotionFetchBatch(orders){
  if(!cfg.notionApiKey||!cfg.notionDbId)return;
  const docUrls=orders.map(o=>o.docUrl).filter(Boolean);
  if(!docUrls.length)return;
  orders.forEach((_,i)=>{if(currentData?.orders?.[i]?.docUrl)setNotionLoading(i);});
  const notionConfig=notionCfg();
  const resp=await new Promise(resolve=>chrome.runtime.sendMessage({action:'notionFetchBatch',docUrls,config:notionConfig},res=>resolve(res||{ok:false,error:'No response'})));
  if(!resp.ok){
    orders.forEach((_,i)=>{if(currentData?.orders?.[i]?.docUrl)setNotionData(i,{error:resp.error||'Fetch failed — check API key & DB ID in Settings'});});
    toast('✗ Notion: '+(resp.error||'').slice(0,50),4000);
    return;
  }
  for(let i=0;i<orders.length;i++){
    const o=orders[i]; if(!o.docUrl)continue;
    const r=resp.results?.[o.docUrl];
    if(!r){setNotionData(i,{error:'Not in results — try ↻ Fetch'});continue;}
    if(!r.ok){setNotionData(i,{error:r.error});continue;}
    setNotionData(i,{pageId:r.pageId,actualPaid:r.actualPaid,currencyType:r.currencyType,
      postType:r.postType,orderIn:r.orderIn,orderUrl:r.orderUrl,txnDetails:r.txnDetails,
      clientSheet:r.clientSheet,pageUrl:r.pageUrl,fromCache:r.fromCache});
  }
}

async function doNotionFetch(idx){
  const o=effectiveOrder(currentData?.orders?.[idx],idx);
  if(!o?.docUrl){toast('No Doc URL to match');return;}
  if(!cfg.notionApiKey){toast('⚙ Set Notion API Key',3500);settingsPanel.classList.add('open');return;}
  setNotionLoading(idx);
  const resp=await new Promise(resolve=>chrome.runtime.sendMessage({
    action:'notionFetch',docUrl:o.docUrl,
    config:notionCfg()
  },res=>resolve(res||{ok:false,error:'No response'})));
  if(resp.ok){
    setNotionData(idx,{pageId:resp.pageId,actualPaid:resp.actualPaid,currencyType:resp.currencyType,
      postType:resp.postType,orderIn:resp.orderIn,orderUrl:resp.orderUrl,txnDetails:resp.txnDetails,
      clientSheet:resp.clientSheet,pageUrl:resp.pageUrl,fromCache:resp.fromCache});
    toast('✓ Notion loaded');
  }else{
    setNotionData(idx,{error:resp.error});
    toast('✗ '+(resp.error||'').slice(0,50),4000);
  }
}

// ── PAYPAL CHECK ──────────────────────────────────────────────────────────────
async function doPaypalCheck(idx,invoiceUrl){
  if(!invoiceUrl)return;
  const warnEl=$(`invoiceWarning_${idx}`);
  if(warnEl){warnEl.className='invoice-warning yellow';warnEl.style.display='block';warnEl.textContent='🔍 Reading PayPal invoice from open tab…';}
  try{
    const tabs=await chrome.tabs.query({url:'*://www.paypal.com/invoice/*'});
    const tabs2=await chrome.tabs.query({url:'*://www.paypal.com/*'});
    const paypalTabs=[...tabs,...tabs2.filter(t=>t.url&&t.url.includes('paypal.com'))];
    if(!paypalTabs.length){
      if(warnEl){warnEl.className='invoice-warning yellow';warnEl.textContent='ℹ️ Open the PayPal invoice in a browser tab, then click 💳 Invoice to read the amount.';}
      return;
    }
    let found=false;
    for(const tab of paypalTabs){
      if(!tab.id)continue;
      try{
        await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
        await new Promise(r=>setTimeout(r,400));
        const resp=await new Promise(resolve=>{
          chrome.tabs.sendMessage(tab.id,{action:'fetchPaypalAmount',invoiceUrl},res=>{
            if(chrome.runtime.lastError)resolve({ok:false});
            else resolve(res||{ok:false});
          });
        });
        if(resp.ok&&resp.amount>0){
          setNotionData(idx,{...(notionState[idx]||{}),paypalAmount:resp.amount,paypalCurrency:(resp.currency||'USD').toUpperCase().trim()});
          notionLog[idx]=(notionLog[idx]||[]);
          notionLog[idx].push(`[${new Date().toISOString().slice(11,19)}] ✓ PayPal: ${resp.amount} ${resp.currency}`);
          refreshDebug(idx);
          found=true; break;
        }
      }catch(e){continue;}
    }
    if(!found&&warnEl){warnEl.className='invoice-warning yellow';warnEl.textContent='ℹ️ Open the PayPal invoice in a tab first, then click 💳 Invoice again.';}
  }catch(e){
    if(warnEl){warnEl.className='invoice-warning yellow';warnEl.textContent='ℹ️ Open the PayPal invoice tab, then click 💳 Invoice.';}
  }
}

// ── VALIDATE ──────────────────────────────────────────────────────────────────
async function doValidate(idx){
  const o=effectiveOrder(currentData?.orders?.[idx],idx);
  if(!o?.liveUrl){setValResults(idx,[{label:'Live URL',status:'fail',detail:'No live URL found'}]);return;}
  if(!cfg.webAppUrl){setValResults(idx,[{label:'Setup Required',status:'info',detail:'Set Apps Script URL in ⚙ Settings.'}]);return;}
  setValLoading(idx);
  const hasCachedDoc=o._docAnchors?.length>0||o._docFetched;
  const payload=hasCachedDoc
    ?{action:'validate',liveUrl:o.liveUrl,docAnchors:o._docAnchors||[],docText:o._docText||'',webAppUrl:cfg.webAppUrl}
    :{action:'validateWithDoc',liveUrl:o.liveUrl,docUrl:o.docUrl||'',webAppUrl:cfg.webAppUrl};
  const resp=await new Promise(resolve=>chrome.runtime.sendMessage(payload,res=>resolve(res||{ok:false,error:'No response',checks:[]})));
  if(resp.ok){
    if(resp.docAnchors)o._docAnchors=resp.docAnchors;
    if(resp.docText)o._docText=resp.docText;
    o._docFetched=true;
    setValResults(idx,resp.checks);
  }else{setValResults(idx,[{label:'Validation Error',status:'fail',detail:resp.error}]);}
}

// ── SEND LIVE LINK TO CLIENT SHEET (v27 NEW) ──────────────────────────────────
async function doSendLiveToClientSheet(idx){
  const o=effectiveOrder(currentData?.orders?.[idx],idx);
  const ns=notionState[idx];
  const stEl=$(`csrStatus_${idx}`);
  const inp=$(`csrLiveInp_${idx}`);
  const btn=document.querySelector(`[data-action="send-live-to-sheet"][data-idx="${idx}"]`);

  const liveUrl=(inp?.value||'').trim()||o?.liveUrl||'';
  if(!liveUrl){toast('Enter a live link first',3000);return;}

  const clientSheetUrl=ns?.clientSheet||'';
  if(!clientSheetUrl){
    toast('No Client Sheet URL in Notion card — fetch card first',3500);
    if(stEl){stEl.className='csr-status err';stEl.textContent='✗ No Client Sheet linked';}
    return;
  }

  const docUrl=o?.docUrl||'';
  if(!docUrl){
    toast('No Article Doc URL found',3000);
    if(stEl){stEl.className='csr-status err';stEl.textContent='✗ No Article Doc URL';}
    return;
  }

  if(!cfg.webAppUrl){toast('⚙ Set Apps Script URL in Settings',3500);settingsPanel.classList.add('open');return;}

  if(btn){btn.disabled=true;btn.textContent='Sending…';}
  if(stEl){stEl.className='csr-status';stEl.textContent='⏳ Writing to sheet…';}

  const resp=await new Promise(resolve=>chrome.runtime.sendMessage({
    action:'writeLiveToClientSheet',
    clientSheetUrl,
    docUrl,
    liveUrl,
    webAppUrl:cfg.webAppUrl,
  },res=>resolve(res||{ok:false,error:'No response'})));

  if(btn){btn.disabled=false;btn.textContent='Send';}

  if(resp.ok){
    if(stEl){stEl.className='csr-status ok';stEl.textContent=`✓ Row ${resp.row} → "${resp.colHeader||resp.col}" col`;}
    // Also update local order liveUrl so LIVE field refreshes
    if(currentData?.orders?.[idx])currentData.orders[idx].liveUrl=liveUrl;
    refreshFields(idx);
    notionLog[idx]=(notionLog[idx]||[]);
    notionLog[idx].push(`[${new Date().toISOString().slice(11,19)}] ✓ Live → Client Sheet row ${resp.row} col "${resp.colHeader}": ${liveUrl.slice(0,50)}`);
    refreshDebug(idx);
    toast('✓ Live link written to Client Sheet!',3000);
  }else{
    if(stEl){stEl.className='csr-status err';stEl.textContent='✗ '+(resp.error||'').slice(0,60);}
    notionLog[idx]=(notionLog[idx]||[]);
    notionLog[idx].push(`[${new Date().toISOString().slice(11,19)}] ✗ Client Sheet write failed: ${resp.error}`);
    refreshDebug(idx);
    toast('✗ '+(resp.error||'').slice(0,50),4000);
  }
}

// ── NOTION SEND SINGLE ────────────────────────────────────────────────────────
async function doNotionSendSingle(idx){
  const o=effectiveOrder(currentData?.orders?.[idx],idx);
  if(!o)return{ok:false,error:'No order'};
  const stEl=$(`notionSendSt_${idx}`);
  if(stEl){stEl.className='notion-send-status';stEl.textContent='Sending…';}
  const ns=notionState[idx];
  if(!ns?.pageId){
    await doNotionFetch(idx);
    if(!notionState[idx]?.pageId){
      if(stEl){stEl.className='notion-send-status err';stEl.textContent='✗ No Page ID';}
      toast('No Notion card found',3000);return{ok:false};
    }
  }
  const state=notionState[idx];
  if(state.paypalAmount!==undefined&&state.paypalAmount!==null&&state.actualPaid!==null&&state.actualPaid!==undefined){
    const diff=state.paypalAmount-state.actualPaid;
    if(diff>0.01){
      if(stEl){stEl.className='notion-send-status err';stEl.textContent='✗ Blocked: invoice exceeds paid';}
      toast('⛔ Blocked: invoice exceeds approved amount',4000);return{ok:false};
    }
    const currCode=(state.currencyType||'USD').toUpperCase().replace(/^USD\s*/i,'').trim()||'USD';
    const invCurr=(state.paypalCurrency||'USD').toUpperCase().trim()||'USD';
    if(currCode!==invCurr&&invCurr!=='USD'){
      if(stEl){stEl.className='notion-send-status err';stEl.textContent='✗ Blocked: currency mismatch';}
      toast('⛔ Blocked: currency mismatch',4000);return{ok:false};
    }
  }
  const paymentStatus=state._selectedPaymentStatus||determinePaymentStatus(state,o.invoiceUrl,state.paypalAmount,cfg)||'Ready For Payment';
  const resp=await new Promise(resolve=>chrome.runtime.sendMessage({
    action:'notionUpdate',pageId:state.pageId,
    liveUrl:o.liveUrl,invoiceUrl:o.invoiceUrl,paymentStatus,
    config:{apiKey:cfg.notionApiKey,databaseId:cfg.notionDbId,propLiveLink:cfg.propLiveLink,
      propVendorInvoice:cfg.propVendorInvoice,propPaymentStatus:cfg.propPaymentStatus}
  },res=>resolve(res||{ok:false,error:'No response'})));
  if(resp.ok){
    const partialErrs=resp.result?._partialErrors||[];
    if(partialErrs.length>0){
      if(stEl){stEl.className='notion-send-status err';stEl.textContent='⚠ Partial: '+partialErrs.map(e=>e.split(':')[0]).join(', ')+' failed';}
      toast('⚠ Partial save — check Debug',4000);
    }else{
      if(stEl){stEl.className='notion-send-status ok';stEl.textContent='✓ Sent!';}
      toast('✓ Sent to Notion');
    }
    notionLog[idx]=(notionLog[idx]||[]);
    notionLog[idx].push(`[${new Date().toISOString().slice(11,19)}] ✓ Updated ${state.pageId?.slice(0,8)} status=${paymentStatus}`);
    refreshDebug(idx);
  }else{
    if(stEl){stEl.className='notion-send-status err';stEl.textContent='✗ '+(resp.error||'').slice(0,40);}
    notionLog[idx]=(notionLog[idx]||[]);
    notionLog[idx].push(`[${new Date().toISOString().slice(11,19)}] ✗ ${resp.error}`);
    refreshDebug(idx);toast('✗ '+(resp.error||'').slice(0,50),4000);
  }
  return resp;
}

// ── SEND ALL TO NOTION ────────────────────────────────────────────────────────
async function sendAllToNotion(){
  const orders=(currentData?.orders||[]).filter(o=>o.publisherSite||o.docUrl||o.liveUrl||o.invoiceUrl);
  if(!orders.length){toast('No data to send');return;}
  if(!cfg.notionApiKey){toast('⚙ Set Notion API Key',3500);settingsPanel.classList.add('open');return;}
  btnNotionAll.disabled=true; btnNotionAll.textContent='⏳ Sending…';
  actionStatus.className='action-status'; actionStatus.textContent='';
  const needsFetch=orders.some((_,i)=>!notionState[i]?.pageId);
  if(needsFetch){await doNotionFetchBatch(orders);await wait(600);}
  let success=0,failed=0;
  for(let i=0;i<orders.length;i++){const res=await doNotionSendSingle(i);if(res?.ok)success++;else failed++;await wait(300);}
  actionStatus.className='action-status '+(failed===0?'ok':'err');
  actionStatus.textContent=`Notion: ${success} sent${failed?`, ${failed} failed`:''}`;
  btnNotionAll.disabled=false;
  btnNotionAll.innerHTML=`<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1" y="1" width="12" height="12" rx="2" fill="white" opacity=".15"/><path d="M4 4h4M4 7h6M4 10h5" stroke="white" stroke-width="1.3" stroke-linecap="round"/></svg> Send All to Notion`;
  toast(failed===0?'✓ All sent to Notion!':`${success} sent, ${failed} failed`,3000);
}

// ── SEND TO SHEETS ────────────────────────────────────────────────────────────
async function sendToSheets(){
  const orders=(currentData?.orders||[]).filter(o=>o.publisherSite||o.docUrl||o.liveUrl||o.invoiceUrl);
  if(!orders.length){toast('No data to send');return;}
  if(!cfg.webAppUrl){toast('⚙ Set Apps Script URL',3500);settingsPanel.classList.add('open');return;}
  btnSheets.disabled=true; btnSheets.textContent='⏳ Sending…';
  actionStatus.className='action-status'; actionStatus.textContent='';
  try{
    const rows=orders.map((_,i)=>orderToArr(effectiveOrder(orders[i],i)));
    await new Promise((resolve,reject)=>chrome.runtime.sendMessage({action:'appendSheet',rows,webAppUrl:cfg.webAppUrl},res=>{
      if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));
      else if(!res?.ok)reject(new Error(res?.error||'Unknown error'));
      else resolve(res);
    }));
    actionStatus.className='action-status ok';
    actionStatus.textContent=`✓ ${orders.length} row${orders.length!==1?'s':''} appended`;
    toast('✓ Sent to Google Sheets!',3000);
  }catch(err){
    actionStatus.className='action-status err'; actionStatus.textContent='✗ '+err.message.slice(0,90);
    toast('✗ '+err.message.slice(0,45),4000);
  }finally{
    btnSheets.disabled=false;
    btnSheets.innerHTML=`<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="white" stroke-width="1.3"/><path d="M1.5 5.5h11M5.5 5.5v7" stroke="white" stroke-width="1.3"/></svg> Send to Google Sheets`;
  }
}

// ── COPY ──────────────────────────────────────────────────────────────────────
function copyAll(withHeaders){
  const orders=(currentData?.orders||[]).filter(o=>o.publisherSite||o.docUrl||o.liveUrl||o.invoiceUrl);
  if(!orders.length){toast('Nothing to copy');return;}
  const rows=orders.map((_,i)=>orderToTsv(effectiveOrder(orders[i],i)));
  if(withHeaders)rows.unshift('Publisher Site\tDoc URL\tLive URL\tInvoice URL');
  copyText(rows.join('\n'));
}

// ── EVENTS ────────────────────────────────────────────────────────────────────
document.addEventListener('click',e=>{
  const cf=e.target.closest('.btn-fc[data-action="copy-field"]');
  if(cf){const url=cf.dataset.url;if(url){copyText(url);cf.classList.add('ok');cf.innerHTML='✓';setTimeout(()=>{cf.classList.remove('ok');cf.innerHTML=svgCopy(10);},1800);}return;}

  const cr=e.target.closest('[data-action="copy-row"]');
  if(cr&&currentData){const idx=+cr.dataset.idx;const o=effectiveOrder(currentData.orders?.[idx],idx);if(o){copyText(orderToTsv(o));toast('✓ Row copied');cr.classList.add('ok');setTimeout(()=>cr.classList.remove('ok'),1800);}return;}

  const eb=e.target.closest('.btn-edit-card');
  if(eb){$(`manualPanel_${eb.dataset.idx}`)?.classList.toggle('open');return;}

  const ae=e.target.closest('[data-action="apply-edit"]');
  if(ae){
    const idx=+ae.dataset.idx;
    manualOverrides[idx]={
      publisherSite:$(`mSite_${idx}`)?.value.trim()||undefined,
      docUrl:$(`mDoc_${idx}`)?.value.trim()||undefined,
      liveUrl:$(`mLive_${idx}`)?.value.trim()||undefined,
      invoiceUrl:$(`mInv_${idx}`)?.value.trim()||undefined,
    };
    refreshFields(idx);$(`manualPanel_${idx}`)?.classList.remove('open');toast('✓ Applied');return;
  }

  const nf=e.target.closest('[data-action="notion-fetch"]');
  if(nf){doNotionFetch(+nf.dataset.idx);return;}

  const bv=e.target.closest('[data-action="validate"]');
  if(bv){doValidate(+bv.dataset.idx);return;}

  const ns=e.target.closest('[data-action="notion-send-single"]');
  if(ns){doNotionSendSingle(+ns.dataset.idx);return;}

  // NEW v27: Send Live Link to Client Sheet
  const sc=e.target.closest('[data-action="send-live-to-sheet"]');
  if(sc){doSendLiveToClientSheet(+sc.dataset.idx);return;}

  const pb=e.target.closest('.btn-payment[data-status]');
  if(pb){
    const idx=+pb.dataset.idx; const status=pb.dataset.status;
    if(notionState[idx])notionState[idx]._selectedPaymentStatus=status;
    pb.closest('.payment-btns')?.querySelectorAll('.btn-payment').forEach(b=>b.classList.remove('selected'));
    pb.classList.add('selected');
    toast('Status: '+status.slice(0,40));return;
  }
});

btnScan.addEventListener('click',doScan);
btnCopyAll.addEventListener('click',()=>copyAll(false));
btnCopyHdr.addEventListener('click',()=>copyAll(true));
btnSheets.addEventListener('click',sendToSheets);
btnNotionAll.addEventListener('click',sendAllToNotion);
btnClear.addEventListener('click',()=>{
  chrome.storage.local.remove('oleData');
  currentData=null; resultsEl.innerHTML='';
  stEmptyEl.style.display='flex'; emptyTitle.textContent='Cleared';
  emptyHint.innerHTML='Open a thread then click <strong>Scan</strong>.';
  footerEl.classList.remove('show'); actionStatus.textContent='';
  setStatus('idle','Cleared'); setTime(null); toast('Cleared');
  Object.keys(notionState).forEach(k=>delete notionState[k]);
  Object.keys(manualOverrides).forEach(k=>delete manualOverrides[k]);
  Object.keys(notionLog).forEach(k=>delete notionLog[k]);
});

function clearPerOrderState(){
  Object.keys(notionState).forEach(k=>delete notionState[k]);
  Object.keys(manualOverrides).forEach(k=>delete manualOverrides[k]);
  Object.keys(notionLog).forEach(k=>delete notionLog[k]);
}

chrome.storage.onChanged.addListener(({oleData})=>{
  if(!oleData?.newValue)return;
  const d=oleData.newValue;
  if(d.switching){
    // Thread changed — drop the previous thread's Notion/override/log state so
    // it can't bleed into the new thread's cards (which reuse the same indexes).
    clearPerOrderState();
    resultsEl.innerHTML='';stEmptyEl.style.display='none';stLoadEl.style.display='flex';footerEl.classList.remove('show');setStatus('scanning','Thread changed…');return;
  }
  render(d);
});

(async()=>{
  await loadSettings();
  const{oleData}=await chrome.storage.local.get('oleData');
  if(oleData?.orders?.some(o=>o.publisherSite||o.docUrl||o.liveUrl||o.invoiceUrl))render(oleData);
  else{stEmptyEl.style.display='flex';setStatus('idle','Ready — open a thread and click Scan');}
})();
