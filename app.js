'use strict';

// Cloud Mining Tracker — all amounts are BTC; USD/AED is display-only at the live price.
// Data lives in a folder the user picks (File System Access API, Chrome): cloud-mining.json
// plus daily backups. It is mirrored to localStorage so nothing is lost while disconnected.

const APP_VERSION = '1.11.0';
const DATA_VERSION = 4; // 3: deposits may have outside: true (paid straight for admin-added contracts); 4: sales
const STORAGE_KEY = 'cloud-mining-data';
const PREFS_KEY = 'cloud-mining-prefs';
const DATA_FILE = 'cloud-mining.json';
const KEEP_BACKUPS = 30;
const CONTRACT_DAYS = 30;
const AED_PER_USD = 3.6725; // official peg

let data = emptyData();
let dirHandle = null;
let fileState = 'none'; // none | connected | reconnect | unsupported
let backupCount = null;
let backupDoneFor = null;
let btcUsd = null;
let currentTab = 'overview';
let currentScope = null;
let editing = null; // {type: 'deposit'|'check', id} while a row is being edited
let groupDaily = true;
const collapsedMonths = new Set();
const sortState = {};
const proj = { capital: null, per30: null, blockTh: null, blockPrice: null, payoutAt: null, days: 365 }; // null = use current figures
const resetProj = () => Object.assign(proj, { capital: null, per30: null, blockTh: null, blockPrice: null, payoutAt: null });
const charts = {};

let prefs = { unit: 'btc', currency: 'USD', theme: 'auto' };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* defaults */ }
function setPref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  applyTheme();
  render();
}
function applyTheme() {
  if (prefs.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.theme;
}

function emptyData() {
  return {
    version: DATA_VERSION, savedAt: null,
    cycles: [],        // {id, name, start, notes, reinvestFrom, blockTh, blockPrice, blockPriceDate, payoutFrom, withdrawThreshold (payout amount); old reinvestThreshold is no longer used}
    // purchases may carry leaveOut: true (a contract that was not mining and was not paid for)
    deposits: [],      // {id, cycleId, date, btc, usd, kind: 'new'|'recycled' (withdrawn BTC sent back)|'carry', outside, orders, note}
    balanceChecks: [], // {id, date, btc, note}
    sales: [],         // {id, date, btc, usd, note}: BTC from payouts sold for USDT (wallet side, not tied to a cycle)
    purchases: [],     // from hashrate-purchases report, one per order #
    earnings: [],      // from daily earnings report, one per group per day
    payouts: [],       // from payout report
    summaries: [],     // from profit-capital report, one per contract
    lastImport: null,  // {at, scopeName, files, before, after}
  };
}
function migrate(d) {
  const base = emptyData();
  for (const k of Object.keys(base)) if (d && d[k] !== undefined) base[k] = d[k];
  if ((d?.version || 1) > DATA_VERSION) toast('This data was saved by a newer version of the app. Refresh the page to update.', true);
  base.version = DATA_VERSION;
  return base;
}

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const sum = (arr, f) => arr.reduce((a, x) => a + (typeof f === 'function' ? f(x) : x[f]), 0);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayIso = () => new Date().toLocaleDateString('en-CA');
const isIso = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
const isFailed = status => /fail|reject|cancel/i.test(status || '');
const isDone = status => /complet|success|paid|done/i.test(status || '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}
function num(s) {
  if (s == null) return NaN;
  return parseFloat(String(s).replace(/BTC/i, '').replace(/[$,%\s]/g, ''));
}

// Amounts follow the BTC/sats preference; tables put the unit in the header.
const unitLabel = () => (prefs.unit === 'sats' ? 'sats' : 'BTC');
const unitScale = () => (prefs.unit === 'sats' ? 1e8 : 1);
function fmtAmt(v, sign = false) {
  if (!isFinite(v)) return '—';
  let s;
  if (prefs.unit === 'sats') {
    const n = Math.round(Math.abs(v) * 1e8);
    s = n.toLocaleString('en-US');
    if (n === 0) return '0';
  } else {
    s = Math.abs(v).toFixed(8);
    if (s === '0.00000000') return s;
  }
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + s;
}
const fmtAmtU = (v, sign = false) => `${fmtAmt(v, sign)} ${unitLabel()}`;
function fmtMoney(usdValue) {
  if (!isFinite(usdValue)) return '—';
  const v = prefs.currency === 'AED' ? usdValue * AED_PER_USD : usdValue;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < -0.005 ? '−' : '') + (prefs.currency === 'AED' ? 'AED ' : '$') + s;
}
function fmtPct(v, dp = 2, sign = false) {
  if (!isFinite(v)) return '—';
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + Math.abs(v * 100).toFixed(dp) + '%';
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtMonth(ym) {
  return new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}
function tone(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }

function lastReportPrice() {
  const last = [...data.earnings].sort(byDate).at(-1);
  return last && last.btcUsd > 0 ? last.btcUsd : null;
}
function usdPrice() { return btcUsd || lastReportPrice(); }
function fiat(btc) {
  const p = usdPrice();
  return p && isFinite(btc) ? fmtMoney(btc * p) : '';
}

// ---------- CSV ----------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(f => f.trim() !== ''));
}

function importCsv(text, filename) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { file: filename, ok: false, msg: 'No data rows found.' };
  const h = rows[0].map(s => s.trim());
  const body = rows.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, (r[i] ?? '').trim()])));
  const has = (...ks) => ks.every(k => h.includes(k));
  if (has('Date', 'Total BTC', 'Cost BTC', 'Profit BTC')) return importEarnings(body, filename);
  if (has('#', 'Contract', 'Type', 'Paid BTC')) return importPurchases(body, filename);
  if (has('Requested', 'Processed', 'Amount')) return importPayouts(body, filename);
  if (has('Contract', 'Capital back', 'Earned BTC')) return importSummaries(body, filename);
  if (has('Settlement Date')) return { file: filename, ok: false, skipped: true, msg: 'Settlements report is not needed — the daily earnings report has the same data plus the capital/profit split. Skipped.' };
  return { file: filename, ok: false, msg: 'Unrecognised report. Columns: ' + h.join(', ') };
}

// Daily earnings: the newest report is the truth for every date it contains,
// so all existing rows for those dates are replaced.
function importEarnings(body, file) {
  const rows = body.filter(r => isIso(r['Date'])).map(r => ({
    date: r['Date'], th: num(r['Hashrate TH/s']), priceThDay: num(r['Price BTC/TH/day']),
    baseBtc: num(r['Base BTC']), bonusPct: num(r['Bonus %']), bonusBtc: num(r['Bonus BTC']),
    totalBtc: num(r['Total BTC']), costBtc: num(r['Cost BTC']), profitBtc: num(r['Profit BTC']),
    btcUsd: num(r['BTC/USD']),
  }));
  const dates = new Set(rows.map(r => r.date));
  const existing = new Set(data.earnings.map(r => r.date));
  const newDays = [...dates].filter(d => !existing.has(d)).length;
  data.earnings = data.earnings.filter(r => !dates.has(r.date)).concat(rows).sort(byDate);
  return { file, ok: true, msg: `Daily earnings: ${dates.size} days (${newDays} new, ${dates.size - newDays} refreshed).` };
}

// Purchases: each order # appears as a "purchased" line (what you paid) and a contract line (what went
// into the contract). Merge into one record per #.
// Lines are told apart by the Contract column, never by Type: a purchased line's Contract is
// "Custom · N TH/s · 30d", a contract line's is its id. Type is "allocated" for the main account, but for a
// contract placed in a sub-account it is the sub-account's name, which the user can rename at any time.
// A contract bought from the balance by the platform's auto-reinvest has no purchased line at all.
// The two lines of an order usually share its #, but not always: a contract added by hand on the platform
// (no "purchased" line) shifts every later contract's # by one. So each contract line (the order's
// identity) is paired with the purchased line of the same day, start and TH/s, nearest # first.
const isBuyLine = r => r['Contract'] ? /^custom\b/i.test(r['Contract']) : /purchas/i.test(r['Type']);
// The sub-account a contract line went into ('' = main account).
const subAccountOf = r => (/^alloc/i.test(r['Type']) ? '' : r['Type'] || '');
function importPurchases(body, file) {
  const rows = body.filter(r => parseInt(r['#'], 10));
  const allocs = rows.filter(r => !isBuyLine(r)).sort((a, b) => parseInt(a['#'], 10) - parseInt(b['#'], 10));
  const buys = rows.filter(isBuyLine);
  const key = r => `${r['Purchased']}|${r['Start']}|${num(r['TH/s'])}`;
  const used = new Set();
  const pairs = allocs.map(alloc => {
    const n = parseInt(alloc['#'], 10);
    const bought = buys.filter(b => !used.has(b) && key(b) === key(alloc))
      .sort((x, y) => Math.abs(parseInt(x['#'], 10) - n) - Math.abs(parseInt(y['#'], 10) - n))[0] || null;
    if (bought) used.add(bought);
    return { n, alloc, bought };
  });
  // A purchased line with no contract yet keeps its own #, unless a contract already has that #.
  for (const bought of buys) {
    const n = parseInt(bought['#'], 10);
    if (!used.has(bought) && !pairs.some(p => p.n === n)) pairs.push({ n, alloc: null, bought });
  }
  let added = 0, updated = 0, rematched = 0;
  for (const { n, alloc, bought } of pairs) {
    const any = alloc || bought;
    const prev = data.purchases.find(p => p.num === n);
    const rec = {
      num: n,
      date: any['Purchased'], start: any['Start'], end: any['End'],
      th: num(any['TH/s']), days: num(any['Days']) || CONTRACT_DAYS,
      paidBtc: num((bought || alloc)['Paid BTC']),
      allocBtc: alloc ? num(alloc['Paid BTC']) : prev?.allocBtc ?? num(bought['Paid BTC']),
      paidUsd: bought ? num(bought['Paid USD']) : alloc ? NaN : prev?.paidUsd ?? NaN,
      // USD at the moment of purchase: the USDT paid, or the BTC at that time's price
      allocUsd: alloc ? num(alloc['Paid USD']) : prev?.allocUsd ?? null,
      contractId: alloc ? alloc['Contract'] : prev?.contractId ?? '',
      status: (alloc || bought)['Status'],
    };
    const sub = alloc ? subAccountOf(alloc) : prev?.subAccount ?? '';
    if (sub) rec.subAccount = sub; else if (prev) delete prev.subAccount;
    if (prev && (prev.date !== rec.date || prev.th !== rec.th || prev.allocBtc !== rec.allocBtc)) rematched++;
    if (prev) { Object.assign(prev, rec); updated++; } else { data.purchases.push(rec); added++; }
  }
  data.purchases.sort((a, b) => a.num - b.num);
  const auto = data.deposits.filter(isFromReports).length;
  const subs = [...new Set(allocs.map(subAccountOf).filter(Boolean))];
  return { file, ok: true, msg: `Purchases: ${added} new contracts, ${updated} refreshed.${subs.length ? ` Sub-accounts: ${subs.join(', ')}.` : ''}${rematched ? ` ${plural(rematched, 'contract')} matched to the right purchase line now.${auto ? ' The deposits added from the reports were based on the old matching: on Money in & out, use "Remove all deposits added from the reports", then add them again.' : ''}` : ''}` };
}

function importPayouts(body, file) {
  let added = 0, updated = 0;
  for (const r of body) {
    if (!isIso(r['Requested'])) continue;
    const rec = {
      requested: r['Requested'], processed: isIso(r['Processed']) ? r['Processed'] : '',
      btc: num(r['Amount']), source: r['Source'], status: r['Status'], tx: r['TX'] || '',
    };
    const key = p => p.tx || p.requested + '|' + p.btc;
    const prev = data.payouts.find(p => key(p) === key(rec));
    if (prev) { Object.assign(prev, rec); updated++; } else { data.payouts.push(rec); added++; }
  }
  data.payouts.sort((a, b) => (a.requested < b.requested ? -1 : 1));
  return { file, ok: true, msg: `Payouts: ${added} new, ${updated} refreshed.` };
}

function importSummaries(body, file) {
  let added = 0, updated = 0;
  for (const r of body) {
    if (!r['Contract']) continue;
    const rec = {
      contractId: r['Contract'], th: num(r['TH/s']), start: r['Start'], end: r['End'],
      costBtc: num(r['Cost BTC']), earnedBtc: num(r['Earned BTC']), capitalBackBtc: num(r['Capital back']),
      profitBtc: num(r['Profit']), marginPct: num(r['Margin %']), daysSettled: num(r['Days settled']),
    };
    const prev = data.summaries.find(s => s.contractId === rec.contractId);
    if (prev) { Object.assign(prev, rec); updated++; } else { data.summaries.push(rec); added++; }
  }
  return { file, ok: true, msg: `Contract results: ${added} new, ${updated} refreshed.` };
}

// Key figures captured before and after an import, for the "what changed" panel.
function snapshot(scope) {
  const { m, days, P } = compute(scope);
  return {
    days: days.length, last: m.last, contracts: P.length, active: m.activeCount,
    profit: m.profit, withdrawn: m.withdrawn, balance: m.balance, net: m.net, per30: m.windows.d30.per30,
  };
}

async function importFiles(files) {
  ensureScope();
  const scope = currentScope;
  const before = snapshot(scope);
  const results = [];
  for (const f of files) {
    try { results.push(importCsv(await f.text(), f.name)); }
    catch (e) { results.push({ file: f.name, ok: false, msg: 'Could not read: ' + e.message }); }
  }
  if (results.some(r => r.ok)) {
    ensureScope();
    data.lastImport = {
      at: new Date().toISOString(), scope, scopeName: scopeName(scope),
      files: results.map(r => ({ file: r.file, ok: r.ok, skipped: !!r.skipped, msg: r.msg })),
      before, after: snapshot(scope),
    };
    currentTab = 'overview';
    save();
  } else {
    for (const r of results) toast(`${r.file}\n${r.msg}`, !r.skipped);
  }
  render();
}

// ---------- cycles ----------
function cyclesSorted() { return [...data.cycles].sort((a, b) => (a.start < b.start ? -1 : 1)); }
function cycleIdForDate(d) {
  let id = null;
  for (const c of cyclesSorted()) if (c.start <= d) id = c.id;
  return id;
}
function nextCycle(id) {
  const cs = cyclesSorted();
  return cs[cs.findIndex(c => c.id === id) + 1] || null;
}
function scopeName(scope) {
  return scope === 'all' ? 'All time' : data.cycles.find(c => c.id === scope)?.name || '—';
}
function ensureScope() {
  const cs = cyclesSorted();
  if (!currentScope || (currentScope !== 'all' && !cs.some(c => c.id === currentScope))) {
    currentScope = cs.length ? cs.at(-1).id : 'all';
  }
}

// ---------- calculations ----------
// Key relationships (verified against the platform's reports):
//   Total = Base + Bonus; Profit = Total − Cost
//   Cost = the contract's price ÷ 30, i.e. the capital coming back each day
//   so capital-days worked = 30 × Σ Cost, and return per day = Σ Profit ÷ (30 × Σ Cost)
function compute(scope) {
  const inS = d => scope === 'all' || cycleIdForDate(d) === scope;
  const cycle = data.cycles.find(c => c.id === scope) || null;
  const E = data.earnings.filter(r => inS(r.date));
  const P = data.purchases.filter(p => inS(p.date));
  const W = data.payouts.filter(p => inS(p.requested) && !isFailed(p.status));
  const D = scope === 'all'
    ? data.deposits.filter(d => d.kind !== 'carry')
    : data.deposits.filter(d => d.cycleId === scope);
  const nc = scope === 'all' ? null : nextCycle(scope);
  const carryOut = nc ? data.deposits.filter(d => d.cycleId === nc.id && d.kind === 'carry') : [];

  const byDay = new Map();
  for (const r of E) {
    let d = byDay.get(r.date);
    if (!d) { d = { date: r.date, th: 0, total: 0, cost: 0, profit: 0, bonus: 0, base: 0, btcUsd: r.btcUsd, bonusPct: r.bonusPct, rows: 0 }; byDay.set(r.date, d); }
    d.th += r.th; d.total += r.totalBtc; d.cost += r.costBtc; d.profit += r.profitBtc;
    d.bonus += r.bonusBtc; d.base += r.baseBtc; d.rows++;
  }
  const days = [...byDay.values()].sort(byDate);
  const I = insights();
  // A contract that wasn't mining and that the user says wasn't paid for ("leave it out" switch):
  // the "Cost" the report charged for it on every one of its days was really profit of the others.
  const leftOut = I.idle.filter(x => x.p.leaveOut);
  for (const d of days) {
    d.cost0 = d.cost; d.profit0 = d.profit; // as the platform reports them
    d.excluded = sum(leftOut.filter(x => x.p.start <= d.date && d.date <= x.p.end), 'perDay');
    if (d.excluded) { d.cost -= d.excluded; d.profit += d.excluded; }
    d.ret = d.cost > 0 ? d.profit / (d.cost * CONTRACT_DAYS) : NaN;
    // Capital the report took back for a contract that wasn't mining that day (and isn't left out).
    d.idle = sum(I.idle.filter(x => !x.p.leaveOut && x.dates.has(d.date)), 'perDay');
  }

  const m = {};
  // BTC withdrawn and later sent back in is neither new money in nor money kept: it is taken off both.
  // (Balance and net come out the same either way.)
  m.recycled = sum(D.filter(d => d.kind === 'recycled'), 'btc');
  m.in = sum(D, 'btc') - m.recycled;
  // Money paid straight for contracts added by the admin never reached the balance.
  m.outsideIn = sum(D.filter(d => d.outside), 'btc');
  m.carriedOut = sum(carryOut, 'btc');
  // A contract's real cost is its allocated BTC. The report's "purchased" BTC on USDT-paid orders is
  // the USD converted at one report-wide rate, not what left the balance (checked against the dashboard).
  m.paid = sum(P, 'allocBtc');
  m.admin = P.filter(isAdminAdded);
  m.adminValue = sum(m.admin, contractValue);
  m.alloc = m.paid + m.adminValue;
  m.idle = I.idle.filter(x => !x.p.leaveOut && days.some(d => x.dates.has(d.date)));
  m.leftOut = leftOut.filter(x => days.some(d => d.excluded && x.p.start <= d.date && d.date <= x.p.end));
  m.received = sum(days, 'total');
  m.capBack = sum(days, 'cost');
  m.profit = sum(days, 'profit');
  m.bonus = sum(days, 'bonus');
  m.mining = m.profit - m.bonus;
  m.paidOut = sum(W, 'btc');
  m.withdrawn = m.paidOut - m.recycled;
  // Everything sent to the platform reaches the balance, except money paid straight for admin-added contracts.
  m.balance = sum(D.filter(d => !d.outside), 'btc') - m.paid + m.received - m.paidOut - m.carriedOut;
  m.outstanding = Math.max(0, m.alloc - m.capBack);
  m.onPlatform = m.balance + m.outstanding;
  m.net = m.withdrawn + m.carriedOut + m.onPlatform - m.in;
  const loss = days.filter(d => d.profit < 0);
  m.lossDays = loss.length;
  m.lossBtc = sum(loss, 'profit');

  const last = days.at(-1)?.date;
  const win = n => days.filter(d => daysBetween(d.date, last) < n);
  m.windows = { d7: winStats(win(7)), d30: winStats(win(30)), all: winStats(days) };
  m.start = cycle?.start || days[0]?.date || null;
  m.last = last || null;
  m.daysElapsed = m.start && m.last ? daysBetween(m.start, m.last) + 1 : 0;
  m.retOnIn = m.in > 0 ? m.net / m.in : NaN;
  m.retOnInPerDay = m.daysElapsed ? m.retOnIn / m.daysElapsed : NaN;

  const today = todayIso();
  const active = P.filter(p => p.start <= today && today <= p.end);
  m.activeCount = active.length;
  m.activeTh = sum(active, 'th');
  m.working = sum(active, contractValue);

  m.recovered = m.withdrawn + m.carriedOut;
  m.remaining = m.in - m.recovered;
  m.rate = m.windows.d30.profitPerDay;
  m.daysToRecover = m.remaining > 0 && m.rate > 0 ? Math.ceil(m.remaining / m.rate) : null;

  return { m, days, P, W, D, E, cycle, scope };
}

function winStats(ds) {
  const cost = sum(ds, 'cost'), profit = sum(ds, 'profit');
  const idle = sum(ds, d => d.idle || 0);
  const excluded = sum(ds, d => d.excluded || 0);
  const cost0 = sum(ds, d => d.cost0 ?? d.cost), profit0 = sum(ds, d => d.profit0 ?? d.profit);
  return {
    n: ds.length, profit, cost, idle, excluded,
    // what the platform's report says, when a contract is left out
    platformPer30: excluded > 0 && cost0 > 0 ? profit0 / cost0 : NaN,
    platformLossDays: ds.filter(d => (d.profit0 ?? d.profit) < 0).length,
    // the same, leaving out capital taken back for contracts that weren't mining
    adjPer30: idle > 0 && cost - idle > 0 ? (profit + idle) / (cost - idle) : NaN,
    adjLossDays: ds.filter(d => d.profit + (d.idle || 0) < 0).length,
    daily: cost > 0 ? profit / (cost * CONTRACT_DAYS) : NaN,
    per30: cost > 0 ? profit / cost : NaN,
    annual: cost > 0 ? (profit / (cost * CONTRACT_DAYS)) * 365 : NaN,
    profitPerDay: ds.length ? profit / ds.length : NaN,
    lossDays: ds.filter(d => d.profit < 0).length,
  };
}

// Platform balance as the reports say it should be at the end of `date`.
function balanceAt(scope, date) {
  const inS = d => scope === 'all' || cycleIdForDate(d) === scope;
  const le = d => d <= date;
  const deps = (scope === 'all' ? data.deposits.filter(d => d.kind !== 'carry') : data.deposits.filter(d => d.cycleId === scope)).filter(d => le(d.date) && !d.outside);
  const nc = scope === 'all' ? null : nextCycle(scope);
  const carry = nc ? data.deposits.filter(d => d.cycleId === nc.id && d.kind === 'carry' && le(d.date)) : [];
  const paid = sum(data.purchases.filter(p => inS(p.date) && le(p.date)), 'allocBtc');
  const recv = sum(data.earnings.filter(r => inS(r.date) && le(r.date)), 'totalBtc');
  const out = sum(data.payouts.filter(p => inS(p.requested) && le(p.requested) && !isFailed(p.status)), 'btc');
  return sum(deps, 'btc') - paid + recv - out - sum(carry, 'btc');
}

// ---------- reading between the report lines ----------
// Worked out from all imported data (not per cycle):
//  - contracts added by hand on the platform: an allocated line with 0 BTC, so nothing left the balance.
//    They are valued at what the daily report charges back for them (its "Cost" on days when only they
//    and paid contracts with known prices run), else at the USD on their purchased line.
//  - contracts on record that were not mining: the report's TH/s stays below the contracts running,
//    by at least that contract's size, on most of its days — while its capital is still in "Cost".
//  - purchases the platform balance could not have paid for: a day-by-day replay of the balance
//    (deposits + earnings − payouts − purchases). The shortfall had to be new money.
let insightMemo = null;
function insights() {
  const key = [data.earnings.length, data.earnings.at(-1)?.date, data.purchases.length, data.purchases.map(p => p.num + ':' + p.allocBtc).join(),
    data.payouts.length, data.deposits.map(d => d.date + d.btc + d.kind + (d.outside ? 'o' : '')).join()].join('|');
  if (insightMemo?.data === data && insightMemo.key === key) return insightMemo.v;
  const v = { value: new Map(), rate: NaN, admin: [], idle: [], idleByDay: new Map(), gaps: [] };

  const dayAgg = new Map();
  for (const r of data.earnings) {
    const x = dayAgg.get(r.date) || { th: 0, cost: 0, total: 0, btcUsd: r.btcUsd };
    x.th += r.th || 0; x.cost += r.costBtc || 0; x.total += r.totalBtc || 0;
    dayAgg.set(r.date, x);
  }
  const contracts = data.purchases.filter(p => p.contractId && p.th > 0);
  const on = d => contracts.filter(p => p.start <= d && d <= p.end);
  const len = p => p.days || CONTRACT_DAYS;
  v.admin = contracts.filter(p => !(p.allocBtc > 0));

  if (v.admin.length) {
    // First and last days are part-days, so only days when no contract starts or ends are used.
    const edges = new Set(contracts.flatMap(p => [p.start, p.end]));
    const rates = [];
    for (const [d, x] of dayAgg) {
      if (edges.has(d)) continue;
      const act = on(d);
      const adminTh = sum(act.filter(p => !(p.allocBtc > 0)), 'th');
      if (!adminTh) continue;
      const r = (x.cost - sum(act.filter(p => p.allocBtc > 0), p => p.allocBtc / len(p))) / adminTh;
      if (r > 0) rates.push(r);
    }
    rates.sort((a, b) => a - b);
    v.rate = rates.length ? rates[Math.floor(rates.length / 2)] : NaN;
    for (const p of v.admin) {
      const price = dayAgg.get(p.date)?.btcUsd || dayPrices[p.date];
      const val = isFinite(v.rate) ? p.th * len(p) * v.rate : p.paidUsd > 0 && price > 0 ? p.paidUsd / price : 0;
      v.value.set(p.num, +val.toFixed(8));
    }
  }
  const valueOf = p => (p.allocBtc > 0 ? p.allocBtc : v.value.get(p.num) || 0);

  // Largest contracts first, so a missing 800 TH/s isn't blamed on a 300 TH/s one.
  const gap = new Map([...dayAgg].map(([d, x]) => [d, sum(on(d), 'th') - x.th]));
  for (const c of [...contracts].sort((a, b) => b.th - a.th)) {
    const ds = [...dayAgg.keys()].filter(d => c.start <= d && d <= c.end).sort();
    const idle = ds.filter(d => gap.get(d) >= c.th * 0.9);
    if (idle.length < 3 || idle.length < ds.length * 0.5) continue;
    for (const d of idle) gap.set(d, gap.get(d) - c.th);
    const perDay = valueOf(c) / len(c);
    v.idle.push({ p: c, days: ds.length, idleDays: idle.length, from: idle[0], to: idle.at(-1), perDay, dates: new Set(idle) });
    for (const d of idle) v.idleByDay.set(d, (v.idleByDay.get(d) || 0) + perDay);
  }

  const deps = data.deposits.filter(d => d.kind !== 'carry' && !d.outside);
  const pays = data.payouts.filter(p => !isFailed(p.status));
  const buys = data.purchases.filter(p => p.allocBtc > 0).sort((a, b) => a.num - b.num);
  const dates = [...new Set([...deps.map(d => d.date), ...pays.map(p => p.requested), ...buys.map(p => p.date), ...dayAgg.keys()])].sort();
  // A payout can be dated before the earnings it pays out are credited here. That timing gap is kept
  // apart as "ahead" and paid back from the next earnings, so it never counts as money needed, and a
  // deposit added for a suggestion is never used to pay it back (which would make a new suggestion).
  let cash = 0, ahead = 0;
  for (const d of dates) {
    cash -= sum(pays.filter(x => x.requested === d), 'btc');
    if (cash < 0) { ahead -= cash; cash = 0; }
    cash += sum(deps.filter(x => x.date === d), 'btc');
    for (const p of buys.filter(x => x.date === d)) {
      const short = Math.max(0, p.allocBtc - cash);
      if (short > 1e-5) v.gaps.push({ date: d, p, short, full: short > p.allocBtc - 1e-5 });
      cash = Math.max(0, cash + short - p.allocBtc);
    }
    const earned = dayAgg.get(d)?.total || 0;
    const repay = Math.min(ahead, earned);
    ahead -= repay; cash += earned - repay;
  }
  insightMemo = { data, key, v };
  return v;
}
// Payouts that had reached the wallet by `date`, minus what is already recorded as sent back by then.
const walletAvail = date => sum(data.payouts.filter(p => !isFailed(p.status) && payoutDate(p) <= date), 'btc')
  - sum(data.deposits.filter(x => x.kind === 'recycled' && x.date <= date), 'btc');
// The replay's shortfalls, one suggestion per day.
function suggestedDeposits() {
  const by = new Map();
  for (const g of insights().gaps) {
    const s = by.get(g.date) || { date: g.date, btc: 0, usd: 0, usdKnown: true, orders: [], partial: [] };
    s.btc += g.short;
    (g.full ? s.orders : s.partial).push(g.p.num);
    if (g.full && g.p.allocUsd > 0) s.usd += g.p.allocUsd; else s.usdKnown = false;
    by.set(g.date, s);
  }
  // Could it have been BTC withdrawn earlier and sent back? Only if that much had reached the wallet by
  // then and wasn't already sent back. If not, at least part of it must be new money. If it could, the
  // reports can't tell, so "sent back" is only a first guess for the user to check.
  let used = 0;
  return [...by.values()].sort(byDate).map(s => {
    const btc = +s.btc.toFixed(8);
    const avail = Math.max(0, +(walletAvail(s.date) - used).toFixed(8));
    const pick = avail >= btc - 1e-8 ? 'recycled' : 'new';
    if (pick === 'recycled') used += btc;
    return { ...s, btc, usd: s.usdKnown ? +s.usd.toFixed(2) : null, avail, pick };
  });
}
const leaveOutSwitch = (p, on) => `<span class="leave-out"><span class="leave-out-label">Returns and profit:</span>
  <span class="seg small" role="group" aria-label="How to count ${esc(p.contractId)}">
    <button data-act="leave-out" data-num="${p.num}" data-v="count" class="${on ? '' : 'on'}" aria-pressed="${!on}" title="Count it, as the platform's report does">Platform's figures</button><button data-act="leave-out" data-num="${p.num}" data-v="out" class="${on ? 'on' : ''}" aria-pressed="${on}" title="I didn't pay for this contract: count the capital the report took back for it as profit">Leave it out</button>
  </span>${help('Choose "Leave it out" if you did not pay for this contract. Returns, profit, loss days and charts then show what really happened. Your net result and balance are the same either way, and you can switch back at any time.')}</span>`;
// Deposits the app made from the reports (not typed in by hand). Older ones are recognised by their note.
const isFromReports = d => d.auto === true || /^(From the reports:|Paid outside the platform for contract|Paid in USDT for order)/.test(d.note || '');
const isAdminAdded = p => !!p.contractId && p.th > 0 && !(p.allocBtc > 0);
// What a contract really cost: its allocated BTC, or for a contract added by hand, its worked-out value.
// A contract left out (not mining, not paid for) had no capital in it.
const contractValue = p => (p.leaveOut && idleInfo(p) ? 0 : p.allocBtc > 0 ? p.allocBtc : insights().value.get(p.num) || 0);
const idleInfo = p => insights().idle.find(x => x.p.num === p.num) || null;

function contractRows(P) {
  const today = todayIso();
  return P.map(p => {
    const s = data.summaries.find(x => x.contractId && x.contractId === p.contractId);
    const daysLeft = daysBetween(today, p.end);
    return {
      ...p, s,
      value: contractValue(p), admin: isAdminAdded(p), idle: idleInfo(p),
      satsPerTh: (contractValue(p) / p.th) * 1e8,
      state: today < p.start ? 'not started' : today > p.end ? 'ended' : `active · ${daysLeft + 1}d left`,
      active: today >= p.start && today <= p.end,
      shortfall: s ? s.costBtc - s.capitalBackBtc : NaN,
    };
  });
}

function monthRows(R) {
  const months = new Map();
  const get = ym => {
    if (!months.has(ym)) months.set(ym, { ym, days: 0, total: 0, cost: 0, profit: 0, bonus: 0, lossDays: 0, adjLossDays: 0, idle: 0, excluded: 0, cost0: 0, profit0: 0, withdrawn: 0, bought: 0, boughtBtc: 0 });
    return months.get(ym);
  };
  for (const d of R.days) {
    const r = get(d.date.slice(0, 7));
    r.days++; r.total += d.total; r.cost += d.cost; r.profit += d.profit; r.bonus += d.bonus; r.idle += d.idle || 0;
    r.excluded += d.excluded || 0; r.cost0 += d.cost0 ?? d.cost; r.profit0 += d.profit0 ?? d.profit;
    if (d.profit < 0) r.lossDays++;
    if (d.profit + (d.idle || 0) < 0) r.adjLossDays++;
  }
  for (const w of R.W) get(w.requested.slice(0, 7)).withdrawn += w.btc;
  for (const p of R.P) { const r = get(p.date.slice(0, 7)); r.bought++; r.boughtBtc += contractValue(p); }
  return [...months.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1)).map(r => ({
    ...r, per30: r.cost > 0 ? r.profit / r.cost : NaN,
    platformPer30: r.excluded > 0 && r.cost0 > 0 ? r.profit0 / r.cost0 : NaN,
    adjPer30: r.idle > 0 && r.cost - r.idle > 0 ? (r.profit + r.idle) / (r.cost - r.idle) : r.cost > 0 ? r.profit / r.cost : NaN,
  }));
}

function warnings(R) {
  const out = [];
  const { m, days } = R;
  const today = todayIso();
  const add = (level, text) => out.push({ level, text });

  if (!data.cycles.length && (data.earnings.length || data.purchases.length)) {
    add('warn', 'No cycle has been created yet. Go to <b>Settings</b> and start one so deposits and returns can be tracked.');
  }
  if (R.scope !== 'all' && R.P.length && !m.in) add('warn', 'No deposit is recorded for this cycle, so "money in" and the net result are incomplete. Add it on the <b>Money in &amp; out</b> tab.');

  const lastAll = [...data.earnings].sort(byDate).at(-1)?.date;
  const anyActive = data.purchases.some(p => p.start <= today && today <= p.end);
  if (lastAll && anyActive) {
    const age = daysBetween(lastAll, today);
    if (age >= 3) add('warn', `The latest earnings are from ${fmtDate(lastAll)} (${age} days ago) while contracts are still running. Import fresh reports.`);
  }

  const uncovered = [...new Set(data.earnings.map(e => e.date))].filter(d => !data.purchases.some(p => p.start <= d && d <= p.end));
  if (uncovered.length) add('warn', `${plural(uncovered.length, 'day')} of earnings (latest ${fmtDate(uncovered.sort().at(-1))}) have no matching contract. Import the latest <b>hashrate purchases</b> report.`);
  else if (m.capBack > m.alloc + 1e-7 && !m.idle.length) add('warn', 'More capital has come back than was put into contracts — a <b>hashrate purchases</b> report may be missing.');

  for (const x of m.idle) {
    const inView = days.filter(d => x.dates.has(d.date));
    const cost = sum(inView, 'cost'), profit = sum(inView, 'profit'), idle = sum(inView, 'idle');
    const mined = x.days - x.idleDays;
    add('warn', `<b>${esc(x.p.contractId)}</b> (${x.p.th.toLocaleString('en-US')} TH/s, ${fmtDate(x.p.start)} – ${fmtDate(x.p.end)}) is on record but the report's hashrate leaves it out on ${x.idleDays} of its ${x.days} days${mined > 0 ? ` — it only mined on ${plural(mined, 'day')}` : ''}. Its capital (${fmtAmtU(x.perDay)} a day) was still taken out of those days' earnings, so they look like losses that aren't real. Over those days: <b>${fmtPct(profit / cost, 2, true)}</b> per 30 days as the platform reports it, <b>${fmtPct((profit + idle) / (cost - idle), 2, true)}</b> without this contract. Ask the platform about it; if you didn't pay for it, it cost you nothing.
      ${leaveOutSwitch(x.p, false)}`);
  }
  for (const x of m.leftOut) {
    add('keep', `<b>${esc(x.p.contractId)}</b> (${x.p.th.toLocaleString('en-US')} TH/s) is left out: it was on record but not mining, and you didn't pay for it. Returns, profit and loss days count the capital the report took back for it (${fmtAmtU(x.perDay)} a day) as profit, which is what it really was. Your net result and balance are the same either way. ${leaveOutSwitch(x.p, true)}`);
  }
  const unpaid = m.admin.filter(p => !data.deposits.some(d => d.outside && (d.orders || []).includes(p.num)) && !idleInfo(p));
  if (unpaid.length) add('info', `${plural(unpaid.length, 'contract')} (#${unpaid.map(p => p.num).join(', #')}) ${unpaid.length === 1 ? 'was' : 'were'} added by the platform admin: no BTC left the balance for ${unpaid.length === 1 ? 'it' : 'them'}. If you paid for ${unpaid.length === 1 ? 'it' : 'them'} outside the platform, add ${unpaid.length === 1 ? 'it' : 'them'} as money in on the <b>Money in &amp; out</b> tab.`);
  const gaps = suggestedDeposits();
  if (gaps.length) add('info', `The reports show ${plural(gaps.length, 'day')} when contracts cost more than the balance had — ${fmtAmtU(sum(gaps, 'btc'))} of money in that isn't recorded. See <b>Suggested money in</b> on the Money in &amp; out tab.`);

  const checks = data.balanceChecks.filter(c => R.scope === 'all' || cycleIdForDate(c.date) === R.scope).sort(byDate);
  const lc = checks.at(-1);
  if (lc) {
    const diff = lc.btc - balanceAt(R.scope, lc.date);
    if (Math.abs(diff) > 1e-5) add('warn', `Your balance check on ${fmtDate(lc.date)} is ${fmtAmtU(diff, true)} away from the calculated balance. If that day's payout isn't imported yet this is expected; otherwise a report may be missing.`);
  }

  const recent = days.filter(d => daysBetween(d.date, m.last) < 7);
  let streak = 0, best = 0;
  for (const d of recent) { streak = d.profit < 0 ? streak + 1 : 0; best = Math.max(best, streak); }
  if (best >= 2) add('warn', `${best} loss days in a row in the last week — payouts didn't cover the capital due back.`);
  else if (recent.some(d => d.profit < 0)) add('info', `${plural(recent.filter(d => d.profit < 0).length, 'loss day')} in the last 7 days.`);

  for (let i = days.length - 1; i > 0; i--) {
    const a = days[i - 1], b = days[i];
    if (isFinite(a.bonusPct) && isFinite(b.bonusPct) && a.bonusPct !== b.bonusPct) {
      if (daysBetween(b.date, m.last) < 30) add('warn', `The platform bonus changed from ${a.bonusPct}% to ${b.bonusPct}% on ${fmtDate(b.date)}. Most of the profit comes from the bonus, so watch your returns.`);
      break;
    }
  }

  const w = m.windows;
  if (w.d7.n >= 5 && w.all.per30 > 0 && w.d7.per30 < w.all.per30 * 0.5) {
    add('info', `Returns in the last 7 days (${fmtPct(w.d7.per30)} per 30 days) are less than half of the ${R.scope === 'all' ? 'overall' : 'cycle'} average (${fmtPct(w.all.per30)}).`);
  }

  const hidden = hiddenBeforeFirstCycle();
  if (hidden) add('warn', hidden);

  for (const p of R.W.filter(p => !isDone(p.status))) {
    const age = daysBetween(p.requested, today);
    add(age > 7 ? 'warn' : 'info', `Payout of ${fmtAmtU(p.btc)} requested on ${fmtDate(p.requested)} is still "${esc(p.status)}"${age > 7 ? ` after ${age} days. Ask the platform about it` : ''}.`);
  }
  for (const w of platformWarnings(R.scope)) add(w.level, w.text);

  return out;
}

// ---------- platform auto-reinvest and payout ----------
const MIN_BLOCK_TH = 100;  // the platform's smallest reinvest block
const MIN_PAYOUT = 0.001;  // the platform's smallest payout, BTC
const REINVEST_FROM = { off: 'Off', capital: 'Capital only', profit: 'Profit only', both: 'Capital and profit' };
const PAYOUT_FROM = { off: 'Off', profit: 'Profit only', capital: 'Capital only', everything: 'Everything' };
const blockCost = (th, price) => th * CONTRACT_DAYS * price;

// Price of new hashrate in BTC per TH per day: what the user typed from the platform's reinvest page,
// or the latest contract's price (allocated BTC ÷ TH/s ÷ 30) — whichever is newer.
function blockPriceInfo(cycle) {
  const last = data.purchases.filter(p => p.th > 0 && p.allocBtc > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.num - b.num)).at(-1);
  const fromContract = last && { price: last.allocBtc / last.th / CONTRACT_DAYS, date: last.date, src: `from contract #${last.num} on ${fmtDate(last.date)}` };
  const typed = cycle?.blockPrice > 0 && { price: cycle.blockPrice, date: cycle.blockPriceDate || '', src: `entered by you${cycle.blockPriceDate ? ` on ${fmtDate(cycle.blockPriceDate)}` : ''}` };
  const pick = typed && (!fromContract || typed.date >= fromContract.date) ? typed : fromContract;
  if (!pick) return null;
  const age = pick.date ? daysBetween(pick.date, todayIso()) : null;
  return { ...pick, age, stale: age == null || age > 7 };
}

// ---------- does the platform do what it should? ----------
// Two kinds of checks, both shown as Overview warnings and summed up on each cycle's Settings panel:
//  1. The reports against themselves: each daily row's sums, the capital taken back against the contracts
//     running, and contracts bought the same day at the same rate.
//  2. Each cycle's auto-reinvest and auto-payout against the settings the user copied from the platform.
//     A day-by-day replay keeps two pots, capital and profit, fed by each day's earnings. An auto-reinvest
//     on day D can only spend what was waiting at the end of D−1 (the platform settles early the next day),
//     must be whole blocks, and should buy as many blocks as the pot covers. A payout fires when its pot
//     reaches the payout amount. The platform's own split isn't documented: on 10 Nov 2026 it fitted "capital
//     = Base, profit = Bonus" (Base 0.00381441 bought 2 × 150 TH/s = 0.00379485, while Cost was 0.00370244).
//     So the replay runs twice, with capital = Base and with capital = Cost, and something is only reported
//     when it fails both ways. Buys get a day of grace for the timing, and "nothing happened" needs two days.
const isAutoReinvest = p => /^auto-reinvest/i.test(p.contractId || '');
const payoutKind = s => (/\ball\b|every/i.test(s || '') ? 'everything' : /profit/i.test(s || '') ? 'profit' : /capital/i.test(s || '') ? 'capital' : '');
const POOLS = { capital: ['cap'], profit: ['prof'], both: ['cap', 'prof'], everything: ['prof', 'cap'] };
const POOL_LABEL = { capital: 'capital', profit: 'profit', both: 'capital and profit', everything: 'balance' };
const contractRate = p => p.allocBtc / p.th / (p.days || CONTRACT_DAYS);

function dayTotals(keep) {
  const m = new Map();
  for (const r of data.earnings) {
    if (!keep(r.date)) continue;
    const x = m.get(r.date) || { date: r.date, base: 0, bonus: 0, total: 0, cost: 0, th: 0 };
    x.base += r.baseBtc || 0; x.bonus += r.bonusBtc || 0; x.total += r.totalBtc || 0; x.cost += r.costBtc || 0; x.th += r.th || 0;
    m.set(r.date, x);
  }
  return [...m.values()].sort(byDate);
}
// The price of new hashrate on a day: the latest contract bought by then, or the price typed for the cycle.
function rateOn(c, date) {
  const last = data.purchases.filter(p => p.th > 0 && p.allocBtc > 0 && p.date <= date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.num - b.num)).at(-1);
  const typed = c.blockPrice > 0 && (c.blockPriceDate || '') <= date ? c.blockPrice : NaN;
  if (last && (!(typed > 0) || (c.blockPriceDate || '') < last.date)) return contractRate(last);
  return typed > 0 ? typed : NaN;
}

// One replay of a cycle. `def` says what counts as capital: the report's 'base' or its 'cost'.
function replayCycle(c, def) {
  const inC = d => cycleIdForDate(d) === c.id;
  const days = dayTotals(inC);
  const byDay = new Map(days.map(d => [d.date, d]));
  const lastEarn = days.at(-1)?.date;
  const autos = data.purchases.filter(p => isAutoReinvest(p) && p.allocBtc > 0 && inC(p.date));
  const pays = data.payouts.filter(p => inC(p.requested) && !isFailed(p.status));
  const rf = c.reinvestFrom || '', pf = c.payoutFrom || '';
  const blockTh = c.blockTh || MIN_BLOCK_TH;
  const threshold = Math.max(MIN_PAYOUT, c.withdrawThreshold || 0);
  const pool = { cap: 0, prof: 0 };
  const avail = keys => sum(keys, k => pool[k]);
  const take = (keys, amt) => {
    for (const k of keys) { const t = Math.min(Math.max(pool[k], 0), amt); pool[k] -= t; amt -= t; }
    if (amt > 0) pool[keys.at(-1)] -= amt;
  };
  const split = d => { const cap = def === 'base' ? d.base : d.cost; return { cap, prof: d.total - cap }; };
  const todayIn = (d, keys) => { const e = byDay.get(d); if (!e) return 0; const s = split(e); return sum(keys, k => s[k]); };
  const issues = [];
  const missR = [], missP = [];
  const dates = [...new Set([...days.map(d => d.date), ...autos.map(p => p.date), ...pays.map(p => p.requested)])].sort();
  for (const D of dates) {
    // Auto-reinvest bought on D (several contracts on one day count as one buy).
    const buys = autos.filter(p => p.date === D);
    if (buys.length) {
      const th = sum(buys, 'th'), btc = sum(buys, 'allocBtc');
      if (rf === 'off') { issues.push({ type: 'reinvestOff', date: D, th, btc }); take(['cap', 'prof'], btc); }
      else if (rf) {
        const src = POOLS[rf], have = avail(src);
        const blocks = th / blockTh, whole = Math.abs(blocks - Math.round(blocks)) < 1e-6 && Math.round(blocks) >= 1;
        if (!whole) issues.push({ type: 'size', date: D, th });
        if (btc > have + todayIn(D, src) + 1e-7) issues.push({ type: 'overR', date: D, th, btc, have });
        else if (whole) {
          const expect = Math.floor((have + 1e-9) / (btc / Math.round(blocks)));
          if (expect > Math.round(blocks)) issues.push({ type: 'fewer', date: D, th, have, expect, got: Math.round(blocks) });
        }
        take(src, btc);
      } else take(['cap', 'prof'], btc);
    }
    // Payouts requested on D.
    let autoPaid = false;
    for (const p of pays.filter(x => x.requested === D)) {
      const kind = payoutKind(p.source);
      if (pf && pf !== 'off' && kind === pf) {
        autoPaid = true;
        const src = POOLS[pf], have = avail(src);
        if (p.btc > have + todayIn(D, src) + 1e-7) issues.push({ type: 'overP', date: D, btc: p.btc, have, src: pf });
        take(src, p.btc);
      } else {
        if (pf && pf !== 'off') issues.push({ type: 'source', date: D, btc: p.btc, source: p.source });
        take(['prof', 'cap'], p.btc);
      }
    }
    // Something should have happened on D, given what was waiting at the end of D−1 (once D's report is in).
    if (lastEarn && D <= lastEarn) {
      if (POOLS[rf] && rf !== 'everything' && !buys.length) {
        const block = blockCost(blockTh, rateOn(c, D));
        if (avail(POOLS[rf]) >= block - 1e-9) missR.push({ date: D, have: avail(POOLS[rf]), block });
      }
      if (pf && pf !== 'off' && !autoPaid && avail(POOLS[pf]) >= threshold - 1e-9) missP.push({ date: D, have: avail(POOLS[pf]) });
    }
    const e = byDay.get(D);
    if (e) { const s = split(e); pool.cap += s.cap; pool.prof += s.prof; }
  }
  // Two days in a row with nothing done count as missed; report from the first one.
  const streak = list => {
    for (let i = 0; i < list.length - 1; i++) if (daysBetween(list[i].date, list[i + 1].date) === 1) return { ...list[i], days: list.length - i };
    return null;
  };
  const mr = streak(missR), mp = streak(missP);
  if (mr) issues.push({ type: 'missR', ...mr });
  if (mp) issues.push({ type: 'missP', ...mp });
  return { issues, pool: { ...pool }, autos: autos.length, autoPays: pays.filter(p => pf && pf !== 'off' && payoutKind(p.source) === pf).length, lastEarn, threshold, blockTh, days };
}

let checkMemo = null;
function platformChecks() {
  const key = [data.earnings.length, data.earnings.at(-1)?.date, sum(data.earnings, 'totalBtc'), data.purchases.map(p => p.num + ':' + p.allocBtc + ':' + p.date).join(),
    data.payouts.map(p => p.requested + p.btc + p.status).join(), JSON.stringify(data.cycles)].join('|');
  if (checkMemo?.data === data && checkMemo.key === key) return checkMemo.v;
  const v = { report: [], cycles: new Map() };

  // 1. The daily report's own sums.
  const bad = [];
  for (const r of data.earnings) {
    const why = [];
    if (Math.abs(r.totalBtc - r.baseBtc - r.bonusBtc) > 3e-8) why.push('Total ≠ Base + Bonus');
    if (isFinite(r.bonusPct) && Math.abs(r.bonusBtc - r.baseBtc * r.bonusPct / 100) > 3e-8) why.push(`Bonus ≠ ${r.bonusPct}% of Base`);
    if (Math.abs(r.profitBtc - (r.totalBtc - r.costBtc)) > 3e-8) why.push('Profit ≠ Total − Cost');
    if (r.th > 0 && r.priceThDay > 0 && Math.abs(r.baseBtc - r.th * r.priceThDay) > Math.max(3e-8, r.baseBtc * 1e-5)) why.push('Base ≠ TH/s × price');
    if (why.length) bad.push({ date: r.date, why });
  }
  if (bad.length) {
    bad.sort(byDate);
    const l = bad.at(-1);
    v.report.push({ level: 'warn', text: `${plural(bad.length, 'row')} of the <b>daily earnings</b> report ${bad.length === 1 ? "doesn't" : "don't"} add up (latest ${fmtDate(l.date)}: ${l.why.join(', ')}). Ask the platform about it.` });
  }

  // Capital taken back each day = the running contracts' prices ÷ 30. First and last days are part-days, and
  // contracts added by the admin or not mining have no known price, so those days are skipped.
  const contracts = data.purchases.filter(p => p.contractId && p.th > 0);
  const edges = new Set(contracts.flatMap(p => [p.start, p.end]));
  const odd = contracts.filter(p => !(p.allocBtc > 0) || idleInfo(p));
  const costOff = [];
  for (const d of dayTotals(() => true)) {
    if (edges.has(d.date)) continue;
    const on = contracts.filter(p => p.start <= d.date && d.date <= p.end);
    if (!on.length || on.some(p => odd.includes(p))) continue;
    const expect = sum(on, p => p.allocBtc / (p.days || CONTRACT_DAYS));
    if (Math.abs(d.cost - expect) > 1e-7 + on.length * 1e-8) costOff.push({ date: d.date, cost: d.cost, expect });
  }
  if (costOff.length) {
    const l = costOff.at(-1);
    v.report.push({ level: 'warn', text: `On ${plural(costOff.length, 'day')} the capital the report took back (Cost) isn't your running contracts' price ÷ 30 (latest ${fmtDate(l.date)}: ${fmtAmtU(l.cost)} taken back, ${fmtAmtU(l.expect)} expected). A contract may be missing from the <b>hashrate purchases</b> report, or the platform is paying back the wrong amount.` });
  }

  // (Same-day contracts don't always share one rate: an order paid in USDT gets its BTC at that moment's
  // USD price, so the friend's #30/#31 differ by 0.17%. Not checked.)

  // The mining part of the profit: Base above Cost. When Base only pays the capital back, the bonus is all the profit.
  const all = dayTotals(() => true).filter(d => d.cost > 0);
  let flat = 0;
  for (let i = all.length - 1; i >= 0 && Math.abs(all[i].base - all[i].cost) <= Math.max(1e-7, all[i].cost * 1e-4); i--) flat++;
  if (flat >= 2 && flat < all.length) {
    const from = all[all.length - flat], l = all.at(-1);
    v.report.push({ level: 'info', text: `Since ${fmtDate(from.date)} the mining part pays back exactly your capital (Base = Cost), so all your profit is the ${isFinite(l.bonus / l.base) ? fmtPct(l.bonus / l.base, 0) + ' ' : ''}bonus. Before, Base was above Cost.` });
  }

  // 2. Each cycle's auto-reinvest and payout.
  for (const c of data.cycles) {
    const A = replayCycle(c, 'base'), B = replayCycle(c, 'cost');
    const keyOf = i => i.type + i.date;
    const inB = new Set(B.issues.map(keyOf));
    const issues = A.issues.filter(i => inB.has(keyOf(i)));
    // Did one way of counting capital fit the buys and the other not? Then say which.
    const fails = R => R.issues.filter(i => /^(overR|fewer)$/.test(i.type)).length;
    const fit = !fails(A) && fails(B) ? 'base' : fails(A) && !fails(B) ? 'cost' : '';
    v.cycles.set(c.id, { c, issues, A, fit, autos: A.autos, autoPays: A.autoPays });
  }
  checkMemo = { data, key, v };
  return v;
}

// Warnings for one view: the report checks always, the cycle checks for the cycles in it.
function platformWarnings(scope) {
  const P = platformChecks();
  const out = [...P.report];
  for (const [id, x] of P.cycles) {
    if (scope !== 'all' && scope !== id) continue;
    const { c } = x, name = esc(c.name);
    const rf = c.reinvestFrom, pf = c.payoutFrom;
    const block = th => `${th.toLocaleString('en-US')} TH/s`;
    const hint = 'Import the latest reports first; if it still shows, check the setting on the platform or ask them.';
    for (const i of x.issues) {
      const t = {
        reinvestOff: () => ['warn', `Auto-reinvest bought ${block(i.th)} (${fmtAmtU(i.btc)}) on ${fmtDate(i.date)}, but auto-reinvest is Off in ${name}'s settings. Check the setting on the platform, then copy it on <b>Settings</b>.`],
        size: () => ['warn', `Auto-reinvest bought ${block(i.th)} on ${fmtDate(i.date)}: not a whole number of your ${block(c.blockTh || MIN_BLOCK_TH)} blocks. Check the block size on the platform matches ${name}'s settings.`],
        overR: () => ['warn', `Auto-reinvest on ${fmtDate(i.date)} spent ${fmtAmtU(i.btc)} on ${block(i.th)}, but only ${fmtAmtU(i.have)} of ${POOL_LABEL[rf]} was waiting. Is the platform still set to reinvest "${REINVEST_FROM[rf]}"?`],
        fewer: () => ['warn', `On ${fmtDate(i.date)} the ${POOL_LABEL[rf]} waiting (${fmtAmtU(i.have)}) covered ${i.expect} blocks, but auto-reinvest bought ${i.got}. ${hint}`],
        missR: () => ['warn', `Since ${fmtDate(i.date)} the ${POOL_LABEL[rf]} waiting (${fmtAmtU(i.have)}) has covered a ${block(c.blockTh || MIN_BLOCK_TH)} block (${fmtAmtU(i.block)}), but no auto-reinvest is in the reports. ${hint}`],
        overP: () => ['warn', `The payout of ${fmtAmtU(i.btc)} on ${fmtDate(i.date)} is more than the ${POOL_LABEL[i.src]} that was waiting (${fmtAmtU(i.have)}). Is auto-payout still set to "${PAYOUT_FROM[i.src]}"?`],
        missP: () => ['warn', `Since ${fmtDate(i.date)} the ${POOL_LABEL[pf]} waiting (${fmtAmtU(i.have)}) has reached your payout amount (${fmtAmtU(x.A.threshold)}), but no auto-payout is in the reports. ${hint}`],
      }[i.type]?.();
      if (t) out.push({ level: t[0], text: t[1] });
    }
    // Payouts whose Source isn't the auto-payout setting: one line for all of them.
    const other = x.issues.filter(i => i.type === 'source');
    if (other.length) {
      const l = other.at(-1), labels = [...new Set(other.map(i => `"${esc(i.source)}"`))].join(', ');
      out.push({ level: 'info', text: `${plural(other.length, 'payout')} in ${name} (latest ${fmtAmtU(l.btc)} on ${fmtDate(l.date)}) ${other.length === 1 ? 'has' : 'have'} the source ${labels}, not your auto-payout setting (${PAYOUT_FROM[pf]}), so the app treats ${other.length === 1 ? 'it' : 'them'} as asked for by hand. If an auto-payout shows up like this, the platform's setting may differ from yours.` });
    }
    if (x.autos && !rf) out.push({ level: 'info', text: `The platform made ${plural(x.autos, 'auto-reinvest buy')} in ${name}. Copy its auto-reinvest and payout settings on <b>Settings</b> so the app can check them.` });
  }
  return out;
}

// One line per cycle for its Settings panel: what was checked, and what is waiting for the next block or payout.
function checkSummary(c) {
  const x = platformChecks().cycles.get(c.id);
  if (!x || !x.A.lastEarn) return '';
  const { A, issues, fit } = x;
  const rf = c.reinvestFrom, pf = c.payoutFrom;
  if (!(rf && rf !== 'off') && !(pf && pf !== 'off') && !x.autos) return '';
  const parts = [];
  const warnN = issues.filter(i => i.type !== 'source').length;
  parts.push(warnN ? `<span class="warn">⚠ ${plural(warnN, 'thing')} ${warnN === 1 ? "doesn't" : "don't"} match your settings: see the Overview.</span>`
    : (() => {
      const what = [rf && rf !== 'off' ? plural(x.autos, 'auto-reinvest buy') : '', pf && pf !== 'off' ? plural(x.autoPays, 'auto-payout') : ''].filter(Boolean);
      const n = (rf && rf !== 'off' ? x.autos : 0) + (pf && pf !== 'off' ? x.autoPays : 0);
      return n ? `✓ ${what.join(' and ')} up to ${fmtDate(A.lastEarn)} ${what.length === 1 && n === 1 ? 'matches' : 'match'} your settings.`
        : `✓ Nothing was due up to ${fmtDate(A.lastEarn)}.`;
    })());
  const recent = A.days.slice(-7);
  const perDay = (keys) => recent.length ? sum(recent, d => sum(keys, k => (k === 'cap' ? d.base : d.total - d.base))) / recent.length : NaN;
  const eta = (have, need, keys, due) => {
    if (have >= need) return `: ${due} is due next`;
    const r = perDay(keys);
    return r > 0 ? `, about ${plural(Math.ceil((need - have) / r), 'day')} to go` : '';
  };
  if (POOLS[rf] && rf !== 'everything') {
    const bp = blockPriceInfo(c), need = bp ? blockCost(A.blockTh, bp.price) : NaN;
    const have = sum(POOLS[rf], k => A.pool[k]);
    if (isFinite(need)) parts.push(`${POOL_LABEL[rf][0].toUpperCase() + POOL_LABEL[rf].slice(1)} waiting for the next block: <b>${fmtAmtU(Math.max(0, have))}</b> of ${fmtAmtU(need)}${eta(have, need, POOLS[rf], `a buy of ${plural(Math.floor(have / need), 'block')}`)}.`);
  }
  if (pf && pf !== 'off') {
    const have = sum(POOLS[pf], k => A.pool[k]);
    parts.push(`${POOL_LABEL[pf][0].toUpperCase() + POOL_LABEL[pf].slice(1)} waiting for payout: <b>${fmtAmtU(Math.max(0, have))}</b> of ${fmtAmtU(A.threshold)}${eta(have, A.threshold, POOLS[pf], 'a payout')}.`);
  }
  const fitNote = fit === 'base' ? ' The platform counts the report\'s Base column as capital (and the bonus as profit): that is what fits its buys.' : fit === 'cost' ? ' The platform counts the report\'s Cost column as capital: that is what fits its buys.' : '';
  return `<div class="hint" style="margin:8px 0 0"><b>Checked against the reports</b>${help('Each day the app adds the day\'s capital and profit to two pots, takes off what auto-reinvest bought and what was paid out, and checks each step against your settings: whole blocks, no more than was waiting, nothing left undone for two days. Amounts waiting are counted with capital = the Base column, which is what fitted the platform\'s first auto-reinvest.' + fitNote)}<br>${parts.join('<br>')}</div>`;
}

// Day-by-day model of the platform's loop. Each contract pays back 1/30 of its price plus profit every day for 30 days.
// `reinvest` ('off' | 'capital' | 'profit' | 'both') is what goes back in: each day it buys as many whole blocks of
// `block` BTC as it covers, and the rest waits for the next day. Everything else is paid out once it reaches `payoutAt`.
// The balance at the start goes into one contract straight away, unless reinvesting is off.
function simulate({ contracts, balance, rate, days, reinvest, block, payoutAt }) {
  const cs = contracts.map(c => ({ ...c })); // {btc, left}
  let pot = 0, out = 0, withdrawn = 0, payouts = 0, buys = 0;
  if (reinvest === 'off') out = balance;
  else if (balance > 0) cs.push({ btc: balance, left: CONTRACT_DAYS });
  const keepCapital = reinvest === 'capital' || reinvest === 'both';
  const keepProfit = reinvest === 'profit' || reinvest === 'both';
  const cap = [], wd = [], face = [], back = [0], wait = [];
  const step = () => {
    const n = reinvest !== 'off' && block > 0 ? Math.floor(pot / block + 1e-9) : 0;
    if (n > 0) { cs.push({ btc: n * block, left: CONTRACT_DAYS }); pot = Math.max(0, pot - n * block); buys++; }
    if (out > 0 && out >= payoutAt) { withdrawn += out; out = 0; payouts++; }
    const working = sum(cs, c => (c.btc * c.left) / CONTRACT_DAYS);
    cap.push(working + pot + out); wd.push(withdrawn); face.push(sum(cs, 'btc')); wait.push(pot);
  };
  step();
  for (let i = 1; i <= days; i++) {
    let b = 0;
    for (const c of cs) {
      const capBack = c.btc / CONTRACT_DAYS, profit = c.btc * rate;
      b += capBack;
      if (keepCapital) pot += capBack; else out += capBack;
      if (keepProfit) pot += profit; else out += profit;
      c.left--;
    }
    back.push(b);
    for (let j = cs.length - 1; j >= 0; j--) if (cs[j].left <= 0) cs.splice(j, 1);
    step();
  }
  return { cap, wd, face, back, wait, payouts, buys };
}

// ---------- rendering ----------
function help(text) { return `<span class="help" tabindex="0" role="button" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`; }
function card(label, btc, opts = {}) {
  const isText = opts.text != null;
  const valueHtml = isText ? esc(opts.text) : `${fmtAmt(btc, opts.sign)} <small>${unitLabel()}</small>`;
  const f = !isText && opts.fiat !== false ? fiat(btc) : '';
  return `<div class="card">
    <div class="label">${esc(label)} ${opts.help ? help(opts.help) : ''}</div>
    <div class="value ${opts.tone || ''}">${valueHtml}</div>
    ${f ? `<div class="usd">≈ ${f}</div>` : ''}
    ${opts.sub ? `<div class="sub">${opts.sub}</div>` : ''}
  </div>`;
}
// Table cell with a raw sort value.
const td = (v, html, cls = 'n') => `<td class="${cls}" data-v="${esc(v)}">${html}</td>`;

function render() {
  ensureScope();
  renderTopbar();
  renderBanner();
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === currentTab));
  for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
  const main = $('#main');
  const R = compute(currentScope);
  const views = { overview: renderOverview, contracts: renderContracts, history: renderHistory, projection: renderProjection, money: renderMoney, settings: renderSettings };
  main.innerHTML = (views[currentTab] || renderOverview)(R);
  const tabChanged = currentTab !== lastRenderedTab;
  lastRenderedTab = currentTab;
  if (tabChanged) { main.classList.remove('fade-in'); void main.offsetWidth; main.classList.add('fade-in'); }
  moveTabInk();
  if (currentTab === 'overview' && tabChanged) animateHero(main);
  if (currentTab === 'overview') drawOverviewCharts(R);
  if (currentTab === 'contracts') drawContractChart(R);
  if (currentTab === 'projection') drawProjection(R);
  main.querySelectorAll('table[data-sort-id]').forEach(applySort);
}

// ---------- small motion touches (all skipped when the system asks for reduced motion) ----------
const RING_LEN = +(2 * Math.PI * 38).toFixed(1);
let lastRenderedTab = null;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The gradient line under the active tab slides to it.
function moveTabInk() {
  const tabs = $('#tabs');
  let ink = tabs.querySelector('.tab-ink');
  if (!ink) { ink = Object.assign(document.createElement('span'), { className: 'tab-ink' }); tabs.append(ink); }
  const b = tabs.querySelector('button.active');
  if (!b) { ink.style.width = '0'; return; }
  ink.style.left = `${b.offsetLeft}px`;
  ink.style.width = `${b.offsetWidth}px`;
  ink.style.top = `${b.offsetTop + b.offsetHeight - 2}px`;
}

// Net result counts up and the money-back ring fills, when the Overview is opened.
function animateHero(root) {
  if (reducedMotion()) return;
  const ring = root.querySelector('.ring .fill');
  if (ring) {
    const end = ring.getAttribute('stroke-dasharray');
    ring.style.transition = 'none';
    ring.setAttribute('stroke-dasharray', `0 ${RING_LEN}`);
    requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.transition = ''; ring.setAttribute('stroke-dasharray', end); }));
  }
  const el = root.querySelector('[data-count]');
  const target = el ? +el.dataset.count : NaN;
  if (!isFinite(target) || !target) return;
  const t0 = performance.now(), dur = 900;
  const step = t => {
    if (!el.isConnected) return;
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmtAmt(k < 1 ? target * e : target, true);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderTopbar() {
  const sel = $('#scope');
  const cs = cyclesSorted();
  sel.innerHTML = cs.map(c => `<option value="${c.id}">${esc(c.name)} (from ${fmtDate(c.start)})</option>`).join('')
    + `<option value="all">All time</option>`;
  sel.value = currentScope;
  const p = usdPrice();
  $('#price').innerHTML = p
    ? `${btcUsd ? '<span class="live-dot" aria-hidden="true"></span>' : ''}BTC <b>${fmtMoney(p)}</b> <span title="${btcUsd ? 'Live price' : 'No live price — using the BTC/USD from the latest daily report'}">${btcUsd ? '· live' : '· last report'}</span>`
    : 'BTC price unavailable';
  document.querySelectorAll('.seg[data-pref]').forEach(seg => {
    seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', prefs[seg.dataset.pref] === b.dataset.v));
  });
  $('#version').textContent = 'v' + APP_VERSION;
}

function renderBanner() {
  const b = $('#fileBanner');
  const chip = $('#fileChip');
  chip.hidden = fileState !== 'connected';
  if (fileState === 'connected') {
    b.hidden = true;
    chip.textContent = 'Saved';
    chip.title = `Saving to ${dirHandle.name}/${DATA_FILE}${backupCount != null ? ` · ${backupCount} daily backups` : ''}`;
    return;
  }
  const isNew = !data.cycles.length && !data.earnings.length && !data.purchases.length;
  if (isNew && currentTab === 'overview') { b.hidden = true; return; } // the welcome guide covers it
  b.hidden = false;
  if (fileState === 'reconnect') {
    b.innerHTML = `Chrome needs your permission again to save to your data folder <b>${esc(dirHandle?.name || '')}</b>.
      <button class="primary" data-act="reconnect">Reconnect</button>
      <button data-act="open-folder">Choose a different folder</button>`;
  } else if (fileState === 'unsupported') {
    b.innerHTML = `This browser can't save to a folder, so data is kept in this browser only. Open the app in <b>Chrome</b> or <b>Edge</b>, or use <b>Export backup</b> in Settings regularly.`;
  } else if (prefs.bannerHidden === todayIso()) {
    b.hidden = true;
  } else {
    b.innerHTML = `<span>Not connected to a data folder — changes are only kept in this browser.</span>
      <button data-act="open-folder">Choose data folder</button>
      <button class="link quiet" data-act="hide-banner">Hide for today</button>`;
  }
  b.classList.toggle('quiet', fileState === 'none');
}

function renderWelcome() {
  const connected = fileState === 'connected';
  return `<div class="welcome">
    <h1>Welcome to Cloud Mining Tracker</h1>
    <p>Keep track of your cloud-mining contracts, reinvestments and payouts, and see what you're really earning — in BTC, with USD or AED alongside.
    Your data stays on your own computer; nothing is uploaded anywhere.</p>
    <ol class="setup">
      <li class="${connected ? 'done' : ''}">
        <b>Choose a folder for your data.</b> The app saves a file called <code>${DATA_FILE}</code> there, plus a daily backup. Pick an empty folder (for example <i>Documents\\Cloud Mining</i>), or the folder you used before to continue where you left off.
        <div>${connected ? `✓ Saving to <b>${esc(dirHandle.name)}</b>` : fileState === 'unsupported' ? '<span class="warn">Use Chrome or Edge to save to a folder.</span>' : '<button class="primary" data-act="open-folder">Choose data folder</button>'}</div>
      </li>
      <li>
        <b>Start your first cycle.</b> A cycle is one run of the loop: buy a contract, withdraw the profit, reinvest the capital. Enter the date of your first contract and how much BTC you sent to the platform.
        <form class="inline" data-form="cycle" style="margin-top:8px">
          <label>Name<input name="name" value="Cycle 1" required style="width:120px"></label>
          <label>Start date<input type="date" name="start" value="${todayIso()}" required></label>
          <label>BTC sent in<input type="number" name="fresh" step="0.00000001" min="0" style="width:140px" placeholder="0.00000000"></label>
          <button class="primary">Start cycle</button>
        </form>
      </li>
      <li>
        <b>Import your reports.</b> On the platform, download these CSV reports and drop them onto this page (or click <b>Import reports</b>):
        <ul>
          <li><b>Daily earnings</b> — what you receive each day, split into capital back and profit</li>
          <li><b>Hashrate purchases</b> — every contract bought, including automatic reinvestments</li>
          <li><b>Payout report</b> — withdrawals to your wallet</li>
          <li><i>Optional:</i> <b>Profit-capital report</b> — results per contract</li>
        </ul>
        Re-import whenever you like; existing rows are refreshed, never doubled.
        <div><button data-act="import">Import reports</button></div>
      </li>
    </ol>
    <p class="hint">Tip: in Chrome, use the <b>Install</b> icon in the address bar to open this as its own app with a desktop icon.</p>
  </div>`;
}

function renderImportPanel() {
  const li = data.lastImport;
  if (!li) return '';
  const ageH = (Date.now() - Date.parse(li.at)) / 36e5;
  if (ageH > 72) return '';
  const b = li.before, a = li.after;
  const row = (label, x, y, fmt, signed = false) => {
    const changed = fmt(x) !== fmt(y);
    return `<tr class="${changed ? '' : 'same'}"><td>${label}</td><td class="n">${fmt(x)}</td><td class="n">${changed ? '→' : ''}</td><td class="n">${changed ? `<b>${fmt(y)}</b>` : 'no change'}</td>
      <td class="n ${signed ? tone(y - x) : ''}">${changed && typeof x === 'number' && typeof y === 'number' && isFinite(y - x) && fmt !== fmtDate ? (signed ? fmtDelta(y - x, fmt) : '') : ''}</td></tr>`;
  };
  const fmtDelta = (d, fmt) => (fmt === fmtPctPlain ? (d > 0 ? '+' : '−') + Math.abs(d * 100).toFixed(2) + ' pts' : fmt === String ? (d > 0 ? '+' : '') + d : fmtAmt(d, true));
  const bad = li.files.filter(f => !f.ok && !f.skipped).length;
  return `<div class="note-line import-line">
    <details>
    <summary><span>⇩ <b>Last import</b> ${new Date(li.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · ${plural(li.files.length, 'file')}${bad ? ` · <span class="neg">${bad} not imported</span>` : ''}</span> <span class="link">What changed</span></summary>
    <p class="hint" style="margin:8px 0 0">View: ${esc(li.scopeName)}</p>
    <ul class="filelist">${li.files.map(f => `<li class="${f.ok ? '' : f.skipped ? 'muted' : 'neg'}">${esc(f.file)} — ${esc(f.msg)}</li>`).join('')}</ul>
    <table class="compact"><tbody>
      ${row('Data up to', b.last, a.last, fmtDate)}
      ${row('Days of earnings', b.days, a.days, String, true)}
      ${row('Contracts', b.contracts, a.contracts, String, true)}
      ${row('Active contracts', b.active, a.active, String, true)}
      ${row(`Profit (${unitLabel()})`, b.profit, a.profit, v => fmtAmt(v, true), true)}
      ${row(`Withdrawn (${unitLabel()})`, b.withdrawn, a.withdrawn, v => fmtAmt(v), true)}
      ${row(`Balance (${unitLabel()})`, b.balance, a.balance, v => fmtAmt(v), true)}
      ${row(`Net result (${unitLabel()})`, b.net, a.net, v => fmtAmt(v, true), true)}
      ${row('Return per 30 days (last 30 days)', b.per30, a.per30, fmtPctPlain, true)}
    </tbody></table>
    </details>
    <button class="link" data-act="dismiss-import">Dismiss</button>
  </div>`;
}
function fmtPctPlain(v) { return fmtPct(v, 2); }

function renderOverview(R) {
  fetchDayPrices();
  const { m, days } = R;
  const isNew = !data.cycles.length && !data.earnings.length && !data.purchases.length;
  if (isNew) return renderWelcome();
  if (!days.length && !m.in) {
    const why = missingDataHints(R);
    return `${renderNotices(R)}<div class="empty">No data in this view yet.<br><br>
      ${why.length ? why.join('<br><br>') : 'Click <b>Import reports</b> (or drag the CSV files onto this page), and add your deposit on the <b>Money in &amp; out</b> tab.'}</div>`;
  }
  const w = m.windows;
  const retRow = (label, key, dp, helpText) => `<tr><td>${label} ${help(helpText)}</td>
    ${['d7', 'd30', 'all'].map(k => `<td class="n ${tone(w[k][key])}">${fmtPct(w[k][key], dp, true)}</td>`).join('')}</tr>`;
  const checks = data.balanceChecks.filter(c => currentScope === 'all' || cycleIdForDate(c.date) === currentScope).sort(byDate);
  const lastCheck = checks.at(-1);
  const checkDiff = lastCheck ? lastCheck.btc - balanceAt(currentScope, lastCheck.date) : NaN;
  const cyc = R.cycle;
  const u = unitLabel();
  const chart = OV_CHARTS[prefs.ovChart] ? prefs.ovChart : 'daily';

  return `
  ${renderNotices(R)}
  <div class="cols charts-right ov"><div class="left">
  ${renderHero(R)}
  ${renderRunning(R)}

  <h2>Right now</h2>
  <div class="stats">
    ${card('Capital working', m.working, { help: 'Price of all contracts active today.', sub: `${plural(m.activeCount, 'active contract')} · ${m.activeTh.toLocaleString('en-US')} TH/s` })}
    ${card('Available balance', m.balance, { help: 'Calculated: money in − paid for contracts + received − withdrawn. Returned capital and profit waiting for the next reinvest block or payout.', sub: cyc?.reinvestFrom && cyc.reinvestFrom !== 'off' ? `Reinvests ${REINVEST_FROM[cyc.reinvestFrom].toLowerCase()} in ${(cyc.blockTh || MIN_BLOCK_TH).toLocaleString('en-US')} TH/s blocks${cyc.payoutFrom && cyc.payoutFrom !== 'off' ? ` · pays out ${PAYOUT_FROM[cyc.payoutFrom].toLowerCase()} at ${fmtAmt(cyc.withdrawThreshold || MIN_PAYOUT)}` : ''}` : '' })}
    ${lastCheck ? card('Balance check', checkDiff, { sign: true, tone: Math.abs(checkDiff) < 1e-6 ? 'pos' : 'warn', help: 'Your dashboard balance minus the calculated balance on that date. Small differences usually mean a payout that is not in the imported reports yet.', sub: `Dashboard ${fmtAmt(lastCheck.btc)} on ${fmtDate(lastCheck.date)}`, fiat: false }) : ''}
    ${card('Data up to', 0, { text: fmtDate(m.last), sub: plural(days.length, 'day') + ' of earnings' })}
  </div>

  <details class="more" data-fold="ovDetails" ${prefs.ovDetails ? 'open' : ''}>
    <summary>More details <span class="hint">returns table, profit breakdown, money in</span></summary>
    <h3>Returns (in BTC)</h3>
    <p class="hint">Measured on the capital working in contracts — USD/AED price moves don't affect these.</p>
    <div class="table-wrap"><table>
      <thead><tr><th></th><th class="n">Last 7 days</th><th class="n">Last 30 days</th><th class="n">Whole ${currentScope === 'all' ? 'history' : 'cycle'}</th></tr></thead>
      <tbody>
        ${retRow('Return per day', 'daily', 3, 'Profit ÷ capital working, per day.')}
        ${retRow('Return per 30 days', 'per30', 2, 'What one 30-day contract earns on its price at this rate.')}
        ${retRow('Return per year (simple)', 'annual', 1, 'Daily return × 365, not compounded. You withdraw profit, so it does not compound.')}
        <tr><td>Profit (${u})</td>${['d7', 'd30', 'all'].map(k => `<td class="n ${tone(w[k].profit)}">${fmtAmt(w[k].profit, true)}<br><small class="usd">${fiat(w[k].profit)}</small></td>`).join('')}</tr>
        <tr><td>Loss days</td>${['d7', 'd30', 'all'].map(k => `<td class="n ${w[k].lossDays ? 'neg' : ''}">${w[k].lossDays} of ${w[k].n}</td>`).join('')}</tr>
      </tbody>
    </table></div>
    <p class="hint" style="margin-top:8px">On money in: ${fmtPct(m.retOnIn, 2, true)} over ${plural(m.daysElapsed, 'day')} · ${fmtPct(m.retOnInPerDay, 3, true)} per day · ${fmtPct(m.retOnInPerDay * 30, 2, true)} per 30 days.</p>

    <h3>Profit breakdown</h3>
    <div class="stats">
      ${card('Total profit', m.profit, { sign: true, tone: tone(m.profit), help: 'Σ Profit from the daily report (Total − Cost). Includes loss days.', sub: `on ${fmtAmt(m.capBack)} capital returned` })}
      ${card('From the bonus', m.bonus, { help: 'The platform adds a bonus on top of what the hashrate mines.', sub: m.profit ? `${fmtPct(m.bonus / m.profit, 0)} of total profit` : '' })}
      ${card('From mining itself', m.mining, { sign: true, tone: tone(m.mining), help: 'Profit without the bonus. Near zero means the mining only covers the contract price.' })}
      ${card('Loss days', m.lossBtc, { sign: true, tone: m.lossBtc < 0 ? 'neg' : '', help: 'Days where the payout was less than the capital due back. The shortfall is lost capital.', sub: plural(m.lossDays, 'day') })}
    </div>
  </details>
  </div><div class="right">

  <div class="chart-box ov-chart">
    <div class="chart-tabs seg">${Object.entries(OV_CHARTS).map(([k, c]) => `<button data-act="ov-chart" data-v="${k}" class="${k === chart ? 'on' : ''}">${c.label}</button>`).join('')}</div>
    <h3>${OV_CHARTS[chart].title(u)}</h3>
    <div class="canvas"><canvas id="chOverview"></canvas></div>
  </div>
  </div></div>`;
}

const OV_CHARTS = {
  daily: { label: 'Daily profit', title: u => `Daily profit (${u}) and return per day` },
  capital: { label: 'Capital working', title: u => `Capital working in contracts (${u})` },
  cumul: { label: 'Running totals', title: u => `Profit and withdrawn so far (${u})` },
};

// The one card at the top: net result, how much of the money in is back, and where the money is.
function renderHero(R) {
  const { m } = R;
  const pct = m.in > 0 ? Math.min(1, Math.max(0, m.recovered / m.in)) : 0;
  const mini = (label, btc, helpText, sub = '') => `<div class="mini">
    <div class="label">${label} ${help(helpText)}</div>
    <div class="v">${fmtAmt(btc)} <small>${unitLabel()}</small></div>
    <div class="usd">${fiat(btc) ? '≈ ' + fiat(btc) : ''}${sub ? ` · ${sub}` : ''}</div></div>`;
  const backText = !m.in ? ''
    : m.remaining <= 0 ? 'All money in is back — everything from here is profit.'
    : !m.activeCount ? `No contracts are running right now, so nothing more is coming back until new ones start. ${fmtAmtU(m.onPlatform)} is still on the platform.`
    : m.daysToRecover ? `The rest takes about <b>${m.daysToRecover} days</b> at the last 30 days' profit → around <b>${fmtDate(addDays(m.last || todayIso(), m.daysToRecover))}</b>. ${help(`At ${fmtAmtU(m.rate)} profit per day, with capital reinvested and profit withdrawn. See Projection for other scenarios.`)}`
    : 'Not enough profit history yet to say when the rest is back.';
  return `<section class="hero">
    <div class="hero-top">
      <div>
        <div class="label">${m.in ? 'Net result' : 'Profit so far'} ${help(m.in ? 'Withdrawn + still on the platform − money in. This is your real profit or loss after loss days.' : 'No deposit is recorded yet, so this is the profit from the daily report only.')}</div>
        <div class="big ${tone(m.in ? m.net : m.profit)}"><span data-count="${m.in ? m.net : m.profit}">${fmtAmt(m.in ? m.net : m.profit, true)}</span> <small>${unitLabel()}</small></div>
        <div class="usd">${fiat(m.in ? m.net : m.profit) ? '≈ ' + fiat(m.in ? m.net : m.profit) : ''}${m.in ? ` · ${fmtPct(m.retOnIn, 2, true)} of money in` : ''}</div>
      </div>
      ${m.in ? `<div class="back">
        <svg class="ring" viewBox="0 0 92 92" role="img" aria-label="${fmtPct(pct, 1)} of money in is back">
          <defs><linearGradient id="ringGrad" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="var(--accent)"/><stop offset="1" stop-color="var(--accent-2)"/></linearGradient></defs>
          <circle class="track" cx="46" cy="46" r="38"/>
          <circle class="fill" cx="46" cy="46" r="38" transform="rotate(-90 46 46)" data-ring="${pct}" stroke-dasharray="${(pct * RING_LEN).toFixed(1)} ${RING_LEN}"/>
          <text class="ring-pct" x="46" y="51" text-anchor="middle">${fmtPct(pct, 1)}</text>
        </svg>
        <div class="back-text">
          <div class="label">Money back in your wallet</div>
          <div class="hint">${fmtAmtU(m.recovered)} of ${fmtAmtU(m.in)}${m.carriedOut ? ' (incl. carried over)' : ''}. ${backText}</div>
        </div>
      </div>` : ''}
    </div>
    <div class="hero-stats">
      ${m.in ? mini('Money in', m.in, 'BTC you sent to the platform for this cycle (including any balance carried over from the previous cycle).')
        : `<div class="mini"><div class="label">Money in</div><div class="v warn">none yet</div><div class="usd">Add it on the Money in &amp; out tab.</div></div>`}
      ${mini('Withdrawn to your wallet', m.withdrawn, m.recycled ? `Payouts sent to your own wallet (${fmtAmtU(m.paidOut)}), minus the ${fmtAmtU(m.recycled)} you sent back in to buy contracts.` : 'Payouts sent to your own wallet.', m.carriedOut ? `+ ${fmtAmt(m.carriedOut)} carried on` : m.recycled ? `${plural(R.W.length, 'payout')}, ${fmtAmt(m.recycled)} sent back` : plural(R.W.length, 'payout'))}
      ${mini('Still on the platform', m.onPlatform, `Your BTC that is still exposed to the platform: ${fmtAmtU(m.balance)} available balance plus ${fmtAmtU(m.outstanding)} of capital inside contracts that has not come back yet.`)}
    </div>
    ${heroFiat(R)}
  </section>`;
}

// One line in the main card: what went in and where it stands today, in USD/AED.
function heroFiat(R) {
  const F = fiatPosition(R);
  if (!F || !isFinite(F.result) || !(F.inV.usd > 0)) return '';
  const e = F.est ? '~' : '';
  return `<div class="hero-fiat"><span class="lead">In ${prefs.currency}</span>
    <span>Put in <b>${e}${fmtMoney(F.inV.usd)}</b></span>
    <span>Worth today <b>${fmtMoney(F.worth)}</b></span>
    <span>Result <b class="${tone(F.result)}">${e}${F.result > 0.005 ? '+' : ''}${fmtMoney(F.result)}</b> (${fmtPct(F.result / F.inV.usd, 2, true)})</span>
    ${help(`Money in at what it cost you. Worth today = ${F.soldBtc > 0 ? `what you sold for USDT (${fmtMoney(F.soldUsd)}) + ` : ''}BTC still in your wallet (${fmtMoney(F.held)}) + still on the platform (${fmtMoney(F.left + F.carryV.usd)}), at today's price. From mining ${fmtMoney(F.mining)}, from the BTC price ${fmtMoney(F.priceEffect)}${F.soldBtc > 0 ? `, from when you sold ${fmtMoney(F.saleEffect)}` : ''}. Details on Money in & out.`)}</div>`;
}

// One line on how the contracts are doing, for the window picked with the 7d / 30d / all switch.
function renderRunning(R) {
  const key = ['d7', 'd30', 'all'].includes(prefs.runWin) ? prefs.runWin : 'd30';
  const x = R.m.windows[key];
  if (!x || !x.n) return '';
  const names = { d7: '7 days', d30: '30 days', all: currentScope === 'all' ? 'All' : 'Cycle' };
  return `<section class="running">
    <div class="running-head"><h2>How it's running</h2>
      <div class="seg small">${Object.entries(names).map(([k, l]) => `<button data-act="run-win" data-v="${k}" class="${k === key ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="running-line">
      <span class="big ${tone(x.per30)}">${fmtPct(x.per30, 2)}</span> <span class="muted">per 30 days</span> ${help('What one 30-day contract earns on its price at this rate, measured on the capital working.')}
      <span class="dot">·</span> <span class="${tone(x.daily)}">${fmtPct(x.daily, 3, true)}</span> <span class="muted">per day</span>
      <span class="dot">·</span> <span class="${tone(x.profit)}">${fmtAmt(x.profit, true)} ${unitLabel()}</span> <span class="muted">profit${fiat(x.profit) ? ` (${fiat(x.profit)})` : ''}</span>
      <span class="dot">·</span> <span class="${x.lossDays ? 'neg' : ''}">${plural(x.lossDays, 'loss day')}</span> <span class="muted">of ${x.n}</span>
    </div>
    ${x.excluded > 0 ? `<div class="running-line hint">Leaves out the contract that wasn't mining. The platform's report shows ${fmtPct(x.platformPer30, 2)} per 30 days · ${plural(x.platformLossDays, 'loss day')} ${help('You switched this on in the note at the top of the Overview. Switch it off there to see the platform\'s figures everywhere.')}</div>` : ''}
    ${x.idle > 0 ? `<div class="running-line hint">As the platform reports it. Without the contract that wasn't mining:
      <b class="${tone(x.adjPer30)}">${fmtPct(x.adjPer30, 2)}</b> per 30 days · ${plural(x.adjLossDays, 'loss day')} ${help('The report kept taking capital back for a contract its hashrate left out, so those days look worse than they were. This leaves that capital out. See the warning above.')}</div>` : ''}
  </section>`;
}

// Warnings that need action stay as they are; info notes and the last-import summary shrink to one line each.
function renderNotices(R) {
  const ws = warnings(R);
  const warn = ws.filter(w => w.level === 'warn');
  const keep = ws.filter(w => w.level === 'keep'); // notes with a switch: never hidden
  const info = prefs.notesHidden === todayIso() ? [] : ws.filter(w => w.level === 'info');
  const out = [];
  if (warn.length) out.push(`<div class="warnings">${warn.map(w => `<div class="alert warn">⚠ <span>${w.text}</span></div>`).join('')}</div>`);
  for (const k of keep) out.push(`<div class="note-line keep">ℹ <span>${k.text}</span></div>`);
  if (info.length) out.push(`<div class="note-line">ℹ <span>${info.map(w => w.text).join(' · ')}</span> <button class="link" data-act="hide-notes">Hide for today</button></div>`);
  const imp = renderImportPanel();
  if (imp) out.push(imp);
  return out.length ? `<div class="notices">${out.join('')}</div>` : '';
}

// ---------- charts ----------
function chartTheme() {
  const css = getComputedStyle(document.documentElement);
  const v = n => css.getPropertyValue(n).trim();
  const grid = v('--chart-grid'), muted = v('--muted');
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: muted, boxWidth: 12 } } },
    scales: { x: { ticks: { color: muted, maxRotation: 0, autoSkipPadding: 16 }, grid: { color: grid } } },
  };
  const yAxis = (extra = {}) => ({ ticks: { color: muted }, grid: { color: grid }, border: { display: false }, ...extra });
  base.scales.x.border = { display: false };
  base.scales.x.grid = { display: false };
  // Vertical fade from `top` to `bottom` (colors), for bars and filled areas.
  const fade = (top, bottom) => ({ chart }) => {
    const a = chart.chartArea;
    if (!a) return top;
    const g = chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
  };
  const alpha = (c, a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + Math.round(a * 255).toString(16).padStart(2, '0') : c);
  return { v, base, yAxis, fade, alpha };
}
// Soft glow on line charts in the dark theme.
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.register({
    id: 'glow',
    beforeDatasetDraw(chart, { meta }) {
      const on = +getComputedStyle(document.documentElement).getPropertyValue('--glow-on') || 0;
      if (!on || meta.type !== 'line') return;
      const ds = chart.data.datasets[meta.index];
      chart.ctx.save();
      chart.ctx.shadowColor = typeof ds.borderColor === 'string' ? ds.borderColor : 'transparent';
      chart.ctx.shadowBlur = 10;
      meta._glow = true;
    },
    afterDatasetDraw(chart, { meta }) { if (meta._glow) { chart.ctx.restore(); meta._glow = false; } },
  });
}
// Two y-axes (left `y`, right `y1`) whose 0 sits at the same height, so a value below 0 on either side
// is drawn below the same zero line.
function alignedZero(left, right, yAxis) {
  const ext = vals => {
    const f = vals.filter(isFinite);
    return { lo: Math.min(0, ...f), hi: Math.max(0, ...f) };
  };
  const L = ext(left), Rr = ext(right);
  const hiL = L.hi || 1, hiR = Rr.hi || 1;
  const neg = Math.max(-L.lo / hiL, -Rr.lo / hiR); // how far below 0 the chart reaches, as a share of the top
  const pad = 1.08;
  return {
    y: yAxis({ min: -neg * hiL * pad, max: hiL * pad, ticks: { ...yAxis().ticks, maxTicksLimit: 7 } }),
    y1: yAxis({ position: 'right', min: -neg * hiR * pad, max: hiR * pad, grid: { drawOnChartArea: false }, ticks: { ...yAxis().ticks, maxTicksLimit: 7, callback: x => `${+x.toFixed(3)}%` } }),
  };
}
// A thin line at 0 on the left axis.
const zeroLine = color => ({
  id: 'zeroLine',
  afterDatasetsDraw(chart) {
    const y = chart.scales.y?.getPixelForValue(0), a = chart.chartArea;
    if (!isFinite(y) || !a) return;
    const c = chart.ctx;
    c.save(); c.strokeStyle = color; c.globalAlpha = 0.6; c.lineWidth = 1; c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(a.left, y); c.lineTo(a.right, y); c.stroke(); c.restore();
  },
});
const dayLabel = d =>new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function drawOverviewCharts(R) {
  const el = $("#chOverview");
  if (typeof Chart === "undefined" || !R.days.length || !el) return;
  const which = OV_CHARTS[prefs.ovChart] ? prefs.ovChart : "daily";
  const { v, base, yAxis, fade, alpha } = chartTheme();
  const k = unitScale();
  const days = R.days;
  if (which === 'daily') charts.daily = new Chart(el, {
    data: {
      labels: days.map(d => dayLabel(d.date)),
      datasets: [
        { type: 'bar', label: `Profit ${unitLabel()}`, data: days.map(d => d.profit * k), backgroundColor: c => (c.raw < 0 ? v('--neg') : fade(v('--accent-2'), alpha(v('--chart-1'), 0.3))(c)), borderRadius: 2, yAxisID: 'y' },
        { type: 'line', label: 'Return/day %', data: days.map(d => d.ret * 100), borderColor: v('--chart-2'), pointRadius: 0, borderWidth: 2, yAxisID: 'y1' },
      ],
    },
    options: { ...base, scales: { ...base.scales, ...alignedZero(days.map(d => d.profit * k), days.map(d => d.ret * 100), yAxis) } },
    plugins: [zeroLine(v('--muted'))],
  });

  const first = days[0].date, last = days.at(-1).date;
  const span = [];
  for (let d = first; d <= last; d = addDays(d, 1)) span.push(d);
  if (which === 'capital') charts.capital = new Chart(el, {
    type: 'line',
    data: {
      labels: span.map(dayLabel),
      datasets: [{ label: 'Capital working', data: span.map(d => sum(R.P.filter(p => p.start <= d && d <= p.end), contractValue) * k), borderColor: v('--chart-1'), backgroundColor: fade(alpha(v('--chart-1'), 0.35), alpha(v('--chart-1'), 0)), fill: true, pointRadius: 0, stepped: true }],
    },
    options: { ...base, scales: { ...base.scales, y: yAxis({ beginAtZero: true }) } },
  });

  let cp = 0, cw = 0;
  const cum = span.map(d => {
    cp += sum(days.filter(x => x.date === d), 'profit');
    cw += sum(R.W.filter(p => p.requested === d), 'btc');
    return { p: cp * k, w: cw * k };
  });
  if (which === 'cumul') charts.cumul = new Chart(el, {
    type: 'line',
    data: {
      labels: span.map(dayLabel),
      datasets: [
        { label: 'Profit', data: cum.map(c => c.p), borderColor: v('--chart-1'), pointRadius: 0, borderWidth: 2 },        { label: 'Withdrawn', data: cum.map(c => c.w), borderColor: v('--chart-2'), pointRadius: 0, borderWidth: 2, stepped: true },
      ],
    },
    options: { ...base, scales: { ...base.scales, y: yAxis() } },
  });
}

function drawContractChart(R) {
  const el = $('#chPrice');
  if (typeof Chart === 'undefined' || !el) return;
  const { v, base, yAxis, fade, alpha } = chartTheme();
  const rows = contractRows(R.P);
  const prices = rows.map(r => r.satsPerTh).filter(isFinite);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.5, hi * 0.01);
  charts.price = new Chart(el, {
    data: {
      labels: rows.map(r => `#${r.num} · ${dayLabel(r.date)}`),
      datasets: [
        { type: 'bar', label: 'Price (sats per TH, 30 days)', data: rows.map(r => r.satsPerTh), backgroundColor: fade(v('--accent-2'), alpha(v('--chart-1'), 0.35)), borderRadius: 3, yAxisID: 'y' },
        { type: 'line', label: 'Margin %', data: rows.map(r => (r.s && isFinite(r.s.marginPct) ? r.s.marginPct : null)), borderColor: v('--chart-3'), backgroundColor: v('--chart-3'), pointRadius: 3, borderWidth: 2, yAxisID: 'y1', spanGaps: true },
      ],
    },
    options: {
      ...base,
      scales: {
        ...base.scales,
        y: yAxis({ min: Math.floor(lo - pad), max: Math.ceil(hi + pad), title: { display: true, text: 'sats / TH', color: v('--muted') } }),
        y1: yAxis({ position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'margin %', color: v('--muted') } }),
      },
    },
  });
}

// ---------- tabs ----------
// A contract's USD cost: the purchases report's figure, else BTC × that day's average price (an estimate).
function contractUsd(p) {
  if (p.allocUsd > 0) return { usd: p.allocUsd, est: false };
  if (isAdminAdded(p) && p.paidUsd > 0) return { usd: p.paidUsd, est: false };
  const price = dayPrices[p.date];
  return price > 0 ? { usd: contractValue(p) * price, est: true } : { usd: NaN, est: false };
}
function usdCell(p) {
  const { usd, est } = contractUsd(p);
  if (!isFinite(usd)) return td(-1, '—');
  return td(usd, est ? `<span title="Estimate: ${fmtDate(p.date)} average BTC price, as the report gave no USD for this contract.">~${fmtMoney(usd)}</span>` : fmtMoney(usd));
}

function renderContracts(R) {
  fetchDayPrices();
  const rows = contractRows(R.P).reverse();
  if (!rows.length) return `<div class="empty">No contracts in this view. Import the <b>hashrate purchases</b> report.</div>`;
  const hasS = rows.some(r => r.s);
  const u = unitLabel();
  const t = {
    th: sum(rows, 'th'), cost: sum(rows, 'value'), usd: sum(rows, r => contractUsd(r).usd || 0),
    usdEst: rows.some(r => contractUsd(r).est), usdMissing: rows.some(r => !isFinite(contractUsd(r).usd)),
    earned: sum(rows, r => r.s?.earnedBtc || 0), cb: sum(rows, r => r.s?.capitalBackBtc || 0), pr: sum(rows, r => r.s?.profitBtc || 0),
    sf: sum(rows, r => (r.s && !r.active ? r.shortfall : 0)),
  };
  return `
  <div class="cols"><div>
    <h2>Contract price vs result</h2>
    <p class="hint">Bars: what each contract cost per TH (lower = cheaper). Line: the margin it ended with${hasS ? '' : ' — import the profit-capital report to see it'}. Shows whether buying on cheap days pays off.</p>
  </div><div></div></div>
  <div class="chart-box"><div class="canvas" style="height:240px"><canvas id="chPrice"></canvas></div></div>

  <h2>Contracts</h2>
  <p class="hint">Click a column heading to sort. ${hasS ? '"Capital lost" only counts ended contracts.' : 'Import the <b>profit-capital</b> report to see each contract\'s results.'}</p>
  <div class="table-wrap"><table data-sort-id="contracts">
    <thead><tr><th>#</th><th>Bought</th><th>Ends</th><th>Status</th><th class="n">TH/s</th><th class="n">Cost (${u})</th><th class="n">Cost (${prefs.currency})</th><th class="n">sats / TH</th>
      ${hasS ? `<th class="n">Earned (${u})</th><th class="n">Capital back (${u})</th><th class="n">Profit (${u})</th><th class="n">Margin</th><th class="n">Capital lost</th>` : ''}</tr></thead>
    <tbody>
    ${rows.map(r => `<tr>
      ${td(r.num, r.num, '')}${td(r.date, fmtDate(r.date), '')}${td(r.end, fmtDate(r.end), '')}
      ${td(r.active ? 0 : 1, esc(r.state) + (r.idle ? ` <span class="tag warn" title="The report's hashrate leaves this contract out on ${r.idle.idleDays} of its ${r.idle.days} days, but its capital was still taken back.">not mining ${r.idle.idleDays} of ${r.idle.days} days</span>` : '') + (r.idle && r.leaveOut ? ` <span class="tag" title="You left it out of returns and profit (switch on the Overview), so it counts as costing nothing.">left out</span>` : '') + (r.admin ? ` <span class="tag" title="Its allocated BTC is 0: it was added by the platform admin, not bought from your balance. The cost shown is what the daily report charges back for it.">added by admin</span>` : '') + (r.subAccount ? ` <span class="tag" title="Placed in your sub-account &quot;${esc(r.subAccount)}&quot; (from the report's Type column)">${esc(r.subAccount)}</span>` : ''), '')}
      ${td(r.th, r.th.toLocaleString('en-US'))}${td(r.value, r.admin ? `<span title="Worked out: what the daily report charges back for it (no BTC was allocated).">~${fmtAmt(r.value)}</span>` : fmtAmt(r.value))}${usdCell(r)}
      ${td(r.satsPerTh, r.satsPerTh.toFixed(0))}
      ${hasS ? (r.s ? `${td(r.s.earnedBtc, fmtAmt(r.s.earnedBtc))}${td(r.s.capitalBackBtc, fmtAmt(r.s.capitalBackBtc))}
        ${td(r.s.profitBtc, fmtAmt(r.s.profitBtc, true), 'n ' + tone(r.s.profitBtc))}${td(r.s.marginPct, isFinite(r.s.marginPct) ? r.s.marginPct.toFixed(2) + '%' : '—')}
        ${td(r.active ? 0 : -r.shortfall, r.active ? '<small>running</small>' : r.shortfall > 1e-8 ? fmtAmt(-r.shortfall, true) : '—', 'n ' + (!r.active && r.shortfall > 1e-8 ? 'neg' : ''))}`
        : '<td colspan="5" class="hint">no results imported</td>') : ''}
    </tr>`).join('')}
    <tr class="total"><td colspan="4">Total (${rows.length})</td><td class="n">${t.th.toLocaleString('en-US')}</td><td class="n">${fmtAmt(t.cost)}</td><td class="n">${t.usdMissing ? '—' : (t.usdEst ? '~' : '') + fmtMoney(t.usd)}</td><td></td>
      ${hasS ? `<td class="n">${fmtAmt(t.earned)}</td><td class="n">${fmtAmt(t.cb)}</td><td class="n ${tone(t.pr)}">${fmtAmt(t.pr, true)}</td><td class="n">${t.cb ? fmtPct(t.pr / t.cb, 2) : '—'}</td><td class="n ${t.sf > 1e-8 ? 'neg' : ''}">${fmtAmt(-t.sf, true)}</td>` : ''}</tr>
    </tbody>
  </table></div>`;
}

function renderHistory(R) {
  if (!R.days.length) return `<div class="empty">No daily earnings in this view. Import the <b>daily earnings</b> report.</div>`;
  const u = unitLabel();
  const months = monthRows(R);
  const cur = prefs.currency;
  const dayRow = d => `<tr class="${d.profit < 0 ? 'lossrow' : ''}">
      ${td(d.date, fmtDate(d.date), '')}${td(d.th, d.th.toLocaleString('en-US', { maximumFractionDigits: 2 }))}
      ${td(d.total, fmtAmt(d.total))}${td(d.cost, fmtAmt(d.cost))}
      ${td(d.profit, fmtAmt(d.profit, true), 'n ' + tone(d.profit))}${td(d.bonus, fmtAmt(d.bonus))}
      ${td(d.ret, fmtPct(d.ret, 3, true), 'n ' + tone(d.ret))}
      ${td(d.btcUsd, isFinite(d.btcUsd) ? fmtMoney(d.btcUsd) : '—')}${td(d.profit * d.btcUsd, isFinite(d.btcUsd) ? fmtMoney(d.profit * d.btcUsd) : '—')}
    </tr>`;
  const head = `<thead><tr><th>Date</th><th class="n">TH/s</th><th class="n">Received (${u})</th><th class="n">Capital back (${u})</th><th class="n">Profit (${u})</th><th class="n">of which bonus</th><th class="n">Return/day</th><th class="n">BTC/${cur}</th><th class="n">Profit ${cur}</th></tr></thead>`;

  let dailyBody;
  if (groupDaily) {
    dailyBody = [...months].reverse().map(mo => {
      const ds = R.days.filter(d => d.date.startsWith(mo.ym)).reverse();
      const open = !collapsedMonths.has(mo.ym);
      return `<tr class="group" data-act="toggle-month" data-ym="${mo.ym}"><td colspan="2">${open ? '▾' : '▸'} ${fmtMonth(mo.ym)} <small>(${plural(mo.days, 'day')})</small></td>
        <td class="n">${fmtAmt(mo.total)}</td><td class="n">${fmtAmt(mo.cost)}</td><td class="n ${tone(mo.profit)}">${fmtAmt(mo.profit, true)}</td><td class="n">${fmtAmt(mo.bonus)}</td>
        <td class="n">${fmtPct(mo.per30 / CONTRACT_DAYS, 3, true)}</td><td></td><td></td></tr>${open ? ds.map(dayRow).join('') : ''}`;
    }).join('');
  } else {
    dailyBody = [...R.days].reverse().map(dayRow).join('');
  }

  const anyIdle = months.some(mo => mo.idle > 0);
  return `
  <h2>Monthly summary</h2>
  <p class="hint">Calendar months. Return per 30 days = profit ÷ capital back in that month.${anyIdle ? ' "Without idle contract" leaves out the capital the report took back for a contract that wasn\'t mining (see the warning on the Overview).' : ''}</p>
  <div class="table-wrap"><table data-sort-id="months">
    <thead><tr><th>Month</th><th class="n">Days</th><th class="n">Received (${u})</th><th class="n">Profit (${u})</th><th class="n">Profit ${cur} (now)</th><th class="n">Return / 30 days</th>${anyIdle ? `<th class="n">Without idle contract ${help('Return per 30 days and loss days if the capital taken back for the contract that wasn\'t mining is left out.')}</th>` : ''}<th class="n">Loss days</th><th class="n">Withdrawn (${u})</th><th class="n">Contracts bought</th></tr></thead>
    <tbody>${[...months].reverse().map(mo => `<tr>
      ${td(mo.ym, fmtMonth(mo.ym), '')}${td(mo.days, mo.days)}${td(mo.total, fmtAmt(mo.total))}
      ${td(mo.profit, fmtAmt(mo.profit, true), 'n ' + tone(mo.profit))}${td(mo.profit, fiat(mo.profit) || '—')}
      ${td(mo.per30, fmtPct(mo.per30, 2, true) + (isFinite(mo.platformPer30) ? `<br><small class="hint" title="What the platform's report shows, with the contract you left out still counted.">platform: ${fmtPct(mo.platformPer30, 2, true)}</small>` : ''), 'n ' + tone(mo.per30))}
      ${anyIdle ? td(mo.adjPer30, mo.idle > 0 ? `<b>${fmtPct(mo.adjPer30, 2, true)}</b> <small>· ${plural(mo.adjLossDays, 'loss day')}</small>` : '<small>same</small>', 'n ' + (mo.idle > 0 ? tone(mo.adjPer30) : '')) : ''}
      ${td(mo.lossDays, mo.lossDays || '—', 'n ' + (mo.lossDays ? 'neg' : ''))}
      ${td(mo.withdrawn, mo.withdrawn ? fmtAmt(mo.withdrawn) : '—')}${td(mo.bought, mo.bought ? `${mo.bought} <small>(${fmtAmt(mo.boughtBtc)})</small>` : '—')}
    </tr>`).join('')}</tbody>
  </table></div>

  <div class="section-head">
    <h2>Daily earnings</h2>
    <label class="toggle"><input type="checkbox" data-act="group-daily" ${groupDaily ? 'checked' : ''}> Group by month</label>
  </div>
  <p class="hint">One line per day (your groups are added together). Capital back = the "Cost" column. Return/day = profit ÷ (capital back × 30). ${groupDaily ? 'Click a month to collapse it. Untick "Group by month" to sort by any column.' : 'Click a column heading to sort.'}</p>
  <div class="table-wrap"><table ${groupDaily ? '' : 'data-sort-id="daily"'}>${head}<tbody>${dailyBody}</tbody></table></div>`;
}

// What a view is missing, and why: most often a cycle whose dates leave out the imported data.
function missingDataHints(R) {
  const { m, cycle } = R;
  const out = [];
  const dates = data.earnings.map(e => e.date).sort();
  if (!R.days.length) {
    if (!dates.length) out.push('No daily earnings are imported yet. Click <b>Import reports</b> and add the <b>daily earnings</b> report.');
    else if (cycle) {
      const next = nextCycle(cycle.id);
      out.push(`The cycle <b>${esc(cycle.name)}</b> covers ${fmtDate(cycle.start)}${next ? ` to ${fmtDate(addDays(next.start, -1))}` : ' onwards'}, but your daily earnings run from ${fmtDate(dates[0])} to ${fmtDate(dates.at(-1))}, so none of them are in this view. Switch <b>View</b> to "All time", or change the cycle's start date in <b>Settings</b>.`);
    }
  }
  if (!(m.in > 0) && !(m.onPlatform > 0)) {
    out.push(cycle ? `No deposit is recorded for the cycle <b>${esc(cycle.name)}</b>. Add it on the <b>Money in &amp; out</b> tab.`
      : 'No deposit is recorded yet. Add it on the <b>Money in &amp; out</b> tab.');
  }
  return out;
}

// Inputs for the projection: the user's own numbers, or the current figures and the cycle's platform settings.
function projSetup(R) {
  const { m } = R;
  const capital = proj.capital ?? (m.onPlatform > 0 ? m.onPlatform : m.in);
  const per30 = proj.per30 ?? (isFinite(m.windows.d30.per30) ? m.windows.d30.per30 : m.windows.all.per30);
  const cyc = R.cycle || cyclesSorted().at(-1);
  const bp = blockPriceInfo(cyc);
  const blockPrice = proj.blockPrice ?? bp?.price;
  if (!(capital > 0) || !isFinite(per30) || !(blockPrice > 0)) return null;
  const blockTh = proj.blockTh ?? cyc?.blockTh ?? MIN_BLOCK_TH;
  const block = blockCost(blockTh, blockPrice);
  const payoutAt = proj.payoutAt ?? cyc?.withdrawThreshold ?? MIN_PAYOUT;
  const mine = cyc?.reinvestFrom || 'capital';
  const start = m.last || todayIso();
  // Start from the contracts still running and the balance; a different capital scales them.
  let contracts = R.P.filter(p => p.end > start && !idleInfo(p)).map(p => ({ btc: contractValue(p), left: Math.min(CONTRACT_DAYS, daysBetween(start, p.end)) }));
  const inContracts = sum(contracts, c => (c.btc * c.left) / CONTRACT_DAYS);
  let balance = capital - inContracts;
  if (balance < 0) { contracts = contracts.map(c => ({ ...c, btc: (c.btc * capital) / inContracts })); balance = 0; }
  const rate = per30 / CONTRACT_DAYS;
  const run = (reinvest, b) => simulate({ contracts, balance, rate, days: proj.days, reinvest, block: b, payoutAt });
  const scenarios = [
    { key: 'off', label: 'Stop reinvesting', note: 'capital and profit are paid out as they come back' },
    { key: 'capital', label: 'Reinvest capital only', note: 'profit is paid out' },
    { key: 'profit', label: 'Reinvest profit only', note: 'capital is paid out' },
    { key: 'both', label: 'Reinvest capital and profit', note: 'nothing is paid out' },
  ].map(s => ({ ...s, mine: s.key === mine, p: run(s.key, block) }));
  const sizes = [...new Set([100, 200, 300, 500, 1000, blockTh])].sort((a, b) => a - b);
  const blocks = mine === 'off' ? [] : sizes.map(th => ({ th, cost: blockCost(th, blockPrice), p: run(mine, blockCost(th, blockPrice)) }));
  return { capital, per30, rate, cyc, bp, blockTh, blockPrice, block, payoutAt, mine, start, inContracts: Math.min(capital, inContracts), scenarios, blocks };
}

function renderProjection(R) {
  const { m } = R;
  const S = projSetup(R);
  if (!S) {
    const why = missingDataHints(R);
    return `<div class="empty">Not enough data to project yet.<br><br>${why.length ? why.join('<br><br>') : 'Import the daily earnings and hashrate purchases reports, and record your deposit first.'}</div>`;
  }
  const { capital, per30, blockTh, blockPrice, block, payoutAt, start, bp, cyc } = S;
  const days = proj.days;
  const months = days / CONTRACT_DAYS;
  const marks = [30, 90, 180, 365, 730].filter(d => d <= days);
  const u = unitLabel();
  const span = d => (d === 730 ? '2 years' : d === 365 ? '1 year' : d + ' days');
  const total = (p, d = days) => p.wd[d] + p.cap[d];
  const lastMonth = p => p.wd[days] - p.wd[Math.max(0, days - CONTRACT_DAYS)];
  const rows = S.scenarios.map(s => {
    const { cap, wd, face } = s.p;
    const be = m.remaining > 0 ? wd.findIndex(x => m.recovered + x >= m.in) : -1;
    let fr = 0, n = 0;
    for (let i = 1; i <= days; i++) if (cap[i] > 1e-9) { fr += face[i] / cap[i]; n++; }
    const leverage = s.key === 'off' || !n ? NaN : fr / n;
    return { ...s, be, leverage, at: d => ({ cap: cap[d], wd: wd[d] }) };
  });
  const mineRow = rows.find(r => r.mine);
  const settingNote = cyc?.reinvestFrom ? 'your setting' : 'assumed: set yours in Settings';
  // Biggest block the capital coming back can buy every day, with 5% headroom for loss days
  const fitTh = btcPerDay => Math.floor((0.95 * btcPerDay) / (CONTRACT_DAYS * blockPrice));
  const backNow = mineRow.p.back[1], backLater = mineRow.p.back[Math.min(days, CONTRACT_DAYS)];
  const fitText = b => { const th = fitTh(b); return th >= MIN_BLOCK_TH ? `<b>${th.toLocaleString('en-US')} TH/s</b>` : `less than the ${MIN_BLOCK_TH} TH/s minimum, so blocks are bought every few days`; };
  const base = S.blocks.find(b => b.th === MIN_BLOCK_TH);

  return `
  <h2>Projection</h2>
  <p class="hint">A calculator, not a forecast: it plays your loop forward day by day as if your recent return stays the same. Each contract runs 30 days and pays back 1/30 of its price plus profit every day. What you reinvest buys whole blocks of hashrate, like the platform's auto-reinvest; what doesn't cover a whole block waits in your balance, earning nothing, until the next day. Everything else is paid out once it reaches your payout amount. Real returns change daily and loss days happen, and it ignores the risk of keeping BTC on the platform.</p>
  <form class="inline" data-form="projection">
    <label>Capital (BTC)<input type="number" name="capital" step="0.00000001" min="0" value="${(+capital).toFixed(8)}" style="width:140px"></label>
    <label>Return per 30 days (%)<input type="number" name="per30" step="0.01" value="${(per30 * 100).toFixed(2)}" style="width:100px"></label>
    <label>Block size (TH/s)<input type="number" name="blockTh" step="1" min="${MIN_BLOCK_TH}" value="${blockTh}" style="width:100px"></label>
    <label>Block price (BTC per TH per day)<input type="number" name="blockPrice" step="0.000000000001" min="0" value="${blockPrice.toFixed(12)}" style="width:170px"></label>
    <label>Pay out when it reaches (BTC)<input type="number" name="payoutAt" step="0.00000001" min="0" value="${(+payoutAt).toFixed(8)}" style="width:130px"></label>
    <label>Look ahead<select name="days">${[90, 180, 365, 730].map(d => `<option value="${d}" ${d === days ? 'selected' : ''}>${span(d)}</option>`).join('')}</select></label>
    <button class="primary">Update</button>
    <button type="button" data-act="proj-reset">Use my current figures</button>
  </form>
  <p class="hint">Starting on ${fmtDate(start)} with ${fmtAmtU(capital)}${S.inContracts > 0 ? ` (${fmtAmt(S.inContracts)} still in running contracts; the rest goes into one new contract)` : ' in one new contract'}, at ${fmtPct(per30, 2)} per 30 days${proj.per30 == null ? (isFinite(m.windows.d30.per30) ? ' (your last 30 days)' : ' (your whole cycle so far)') : ''}.
    One block of ${blockTh.toLocaleString('en-US')} TH/s costs <b>${fmtAmtU(block)}</b>${fiat(block) ? ` (${fiat(block)})` : ''}.
    Block price ${proj.blockPrice != null ? 'typed here' : bp ? `<span class="${bp.stale ? 'warn' : ''}">${esc(bp.src)}${bp.stale ? ` — ${bp.age != null ? plural(bp.age, 'day') + ' old; ' : ''}check the platform's reinvest page for today's price` : ''}</span>` : ''}.
    ${payoutAt < MIN_PAYOUT ? `<span class="warn">The platform's smallest payout is ${MIN_PAYOUT} BTC.</span>` : ''}
    Money in: ${fmtAmtU(m.in)}, already back: ${fmtAmtU(m.recovered)}.</p>

  <h2>Each scenario at a glance</h2>
  <p class="hint">The four ways the platform's auto-reinvest can be set. Profit and capital that aren't reinvested are paid out.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Reinvest from</th>
      <th class="n">Paid to your wallet per month ${help(`What reaches your wallet in the last 30 days of the ${span(days)} projection.`)}</th>
      <th class="n">Payouts ${help(`How often the amount waiting to be paid out reaches ${fmtAmtU(payoutAt)}, and the average payout.`)}</th>
      <th class="n">Your total after ${span(days)} ${help('Everything paid to your wallet by then, plus what is still on the platform.')}</th>
      <th class="n">Contracts running ${help('Average total price of the running contracts compared with the capital in the loop. A contract earns on its full price for 30 days while its capital comes back daily, so reinvesting that capital lets the same BTC run up to about 2× its value in contracts. BTC waiting for a whole block lowers this.')}</th>
      <th class="n">All money in back in your wallet by</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><b>${esc(r.label)}</b>${r.mine ? ` <span class="pill">${settingNote}</span>` : ''}<br><small class="hint">${esc(r.note)}</small></td>
      <td class="n">${fmtAmtU(lastMonth(r.p))}<br><small class="usd">${fiat(lastMonth(r.p))}</small></td>
      <td class="n">${r.p.payouts ? `${(r.p.payouts / months).toFixed(1)} a month<br><small class="usd">~${fmtAmtU(r.p.wd[days] / r.p.payouts)} each</small>` : '—'}</td>
      <td class="n">${fmtAmtU(total(r.p))}<br><small class="usd">${fiat(total(r.p))}</small></td>
      <td class="n">${isFinite(r.leverage) ? r.leverage.toFixed(2) + '× capital' : '—'}</td>
      <td class="n">${m.remaining <= 0 ? 'already back' : r.be >= 0 ? `${fmtDate(addDays(start, r.be))}<br><small class="usd">in ${plural(r.be, 'day')}</small>` : `not within ${span(days)}`}</td>
    </tr>`).join('')}</tbody>
  </table></div>

  ${S.blocks.length ? `<h2>Choosing a block size</h2>
  <p class="hint">For <b>${esc(mineRow.label.toLowerCase())}</b>. Bigger blocks mean fewer, larger contracts, but the BTC coming back waits in your balance until it covers a whole block, and waiting BTC earns nothing.
    Capital coming back each day: ${fmtAmtU(backNow)} at the start → about ${fmtAmtU(backLater)} after a month, as the blocks you buy start paying back too.
    The biggest block that fills every day (keeping 5% spare for loss days): ${fitText(backNow)} at the start, ${fitText(backLater)} after a month.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Block size</th><th class="n">One block costs</th><th class="n">Purchases per month</th><th class="n">BTC waiting on average</th><th class="n">Paid to your wallet per month ${help(`Average over the ${span(days)}.`)}</th><th class="n">Your total after ${span(days)}</th><th class="n">Profit compared with ${MIN_BLOCK_TH} TH/s ${help(`Profit = your total after ${span(days)} minus the capital you start with. This shows how much of it waiting for bigger blocks costs you.`)}</th></tr></thead>
    <tbody>${S.blocks.map(b => {
      const avgWait = sum(b.p.wait, x => x) / b.p.wait.length;
      const gain = p => total(p) - capital;
      const diff = base && gain(base.p) > 0 ? gain(b.p) / gain(base.p) - 1 : NaN;
      return `<tr class="${b.th === blockTh ? 'current' : ''}">
        <td><b>${b.th.toLocaleString('en-US')} TH/s</b>${b.th === blockTh ? ` <span class="pill">${proj.blockTh != null ? 'typed above' : cyc?.blockTh ? 'your setting' : 'minimum'}</span>` : ''}</td>
        <td class="n">${fmtAmt(b.cost)}<br><small class="usd">${fiat(b.cost)}</small></td>
        <td class="n">${(b.p.buys / months).toFixed(1)}</td>
        <td class="n">${fmtAmt(avgWait)}</td>
        <td class="n">${fmtAmt(b.p.wd[days] / months)}</td>
        <td class="n">${fmtAmt(total(b.p))}</td>
        <td class="n ${tone(diff)}">${Math.abs(diff) < 0.0005 ? '—' : fmtPct(diff, 1, true)}</td></tr>`;
    }).join('')}</tbody>
  </table></div>` : ''}

  <h2>Over time</h2>
  <p class="hint"><b>To your wallet</b>: everything paid out from today up to that point, added up. <b>On the platform</b>: your BTC still there at that point, in contracts or waiting in your balance. Together they are your total.</p>
  <div class="table-wrap"><table class="grouped">
    <thead>
      <tr><th rowspan="2">Reinvest from</th>${marks.map(d => `<th colspan="2" class="grp">After ${span(d)} (${u})<br><small>${fmtDate(addDays(start, d))}</small></th>`).join('')}</tr>
      <tr>${marks.map(() => '<th class="n grp-start">To your wallet</th><th class="n">On the platform</th>').join('')}</tr>
    </thead>
    <tbody>${rows.map(r => `<tr>
      <td><b>${esc(r.label)}</b>${r.mine ? ` <span class="pill">${settingNote}</span>` : ''}</td>
      ${marks.map(d => `<td class="n grp-start">${fmtAmt(r.at(d).wd)}</td><td class="n platform">${fmtAmt(r.at(d).cap)}</td>`).join('')}
    </tr>`).join('')}</tbody>
  </table></div>

  <div class="charts" style="margin-top:12px">
    <div class="chart-box"><h3>Total paid to your wallet (${u})</h3><div class="canvas"><canvas id="chProjW"></canvas></div></div>
    <div class="chart-box"><h3>On the platform (${u})</h3><div class="canvas"><canvas id="chProjC"></canvas></div></div>
  </div>`;
}

function drawProjection(R) {
  if (typeof Chart === 'undefined' || !$('#chProjW')) return;
  const { m } = R;
  const S = projSetup(R);
  if (!S) return;
  const { v, base, yAxis } = chartTheme();
  const k = unitScale();
  const colors = [v('--muted'), v('--chart-1'), v('--chart-3'), v('--chart-2')];
  const step = proj.days > 365 ? 7 : proj.days > 180 ? 3 : 1;
  const idx = [];
  for (let i = 0; i <= proj.days; i += step) idx.push(i);
  const labels = idx.map(i => dayLabel(addDays(S.start, i)));
  const sets = S.scenarios.map((s, i) => ({ ...s, color: colors[i % colors.length] }));
  const line = x => ({ label: x.label, borderColor: x.color, pointRadius: 0, borderWidth: x.mine ? 3 : 2 });
  charts.projW = new Chart($('#chProjW'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        ...sets.filter(x => x.key !== 'both').map(x => ({ ...line(x), data: idx.map(i => x.p.wd[i] * k) })),
        ...(m.remaining > 0 ? [{ label: 'Money in still to recover', data: idx.map(() => m.remaining * k), borderColor: v('--neg'), borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 }] : []),
      ],
    },
    options: { ...base, scales: { ...base.scales, y: yAxis({ beginAtZero: true }) } },
  });
  charts.projC = new Chart($('#chProjC'), {
    type: 'line',
    data: { labels, datasets: sets.map(x => ({ ...line(x), data: idx.map(i => x.p.cap[i] * k) })) },
    options: { ...base, scales: { ...base.scales, y: yAxis({ beginAtZero: true }) } },
  });
}

function renderMoney(R) {
  fetchDayPrices();
  const { m } = R;
  const scope = currentScope;
  const cs = cyclesSorted();
  const deposits = (scope === 'all' ? data.deposits : data.deposits.filter(d => d.cycleId === scope)).slice().sort(byDate);
  const checks = data.balanceChecks.filter(c => scope === 'all' || cycleIdForDate(c.date) === scope).sort(byDate);
  const payouts = data.payouts.filter(p => scope === 'all' || cycleIdForDate(p.requested) === scope);
  const cycleName = id => esc(data.cycles.find(c => c.id === id)?.name || '—');
  const defaultCycle = scope !== 'all' ? scope : cs.at(-1)?.id;
  const cycleSelect = sel => `<select name="cycleId">${cs.map(c => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`;
  const u = unitLabel();
  const cur = prefs.currency;
  const price = usdPrice();
  const estDay = 'Estimate: that day\'s average BTC price.';
  // "then" value, today's value and the change between them
  const valueCells = (then, btc, title) => {
    const now = price ? btc * price : NaN;
    const ch = then.usd > 0 && isFinite(now) ? now / then.usd - 1 : NaN;
    return `<td class="n">${fmtUsdVal(then, title)}</td><td class="n">${isFinite(now) ? fmtMoney(now) : '—'}</td><td class="n ${tone(ch)}">${fmtPct(ch, 1, true)}</td>`;
  };
  const txCell = tx => (/^[0-9a-f]{64}$/i.test(tx)
    ? `<a href="https://mempool.space/tx/${tx}" target="_blank" rel="noopener" title="Open on mempool.space: ${tx}">${tx.slice(0, 12)}…</a>`
    : `<span title="${esc(tx)}">${esc(tx.slice(0, 12))}${tx.length > 12 ? '…' : ''}</span>`);

  const depVals = deposits.map(depositUsd);
  const payVals = payouts.map(payoutUsd);
  const usedOrders = new Set(data.deposits.flatMap(d => d.orders || []));
  const autoDeps = deposits.filter(isFromReports);
  const orderChoices = R.P.filter(p => p.allocUsd > 0 && !usedOrders.has(p.num));
  const needReimport = R.P.some(p => !(p.allocUsd > 0) && !isAdminAdded(p));
  const adminChoices = data.purchases.filter(p => isAdminAdded(p) && !usedOrders.has(p.num) && !(p.leaveOut && idleInfo(p)));
  const suggestions = suggestedDeposits();
  const orderList = list => list.map(p => `#${p}`).join(', ');

  return `${renderFiatResult(R)}
  <div class="cols"><div>
  <h2>Deposits (money in)</h2>
  <p class="hint">Add every amount you send to the platform — the reports don't show deposits. When a new cycle starts with the leftover balance, add that as "Carried over". If you paid in USDT, type the USD amount too; otherwise the app estimates it from that day's average BTC price (marked ~). If you only know the USD, leave BTC empty: the app works it out from that day's average BTC price.</p>
  ${cs.length ? `${suggestions.length ? `<details class="panel" style="margin:10px 0" open>
    <summary><b>Suggested money in</b> <span class="hint">· ${plural(suggestions.length, 'day')} · ${fmtAmtU(sum(suggestions, 'btc'))}</span></summary>
    <p class="hint" style="margin-top:8px">The app replays your platform balance day by day from the reports (money in + earnings − payouts − contracts). On these days a contract cost more than the balance had, so the difference must have come in from outside. For each day, choose whether it was <b>new money</b> or <b>BTC you had withdrawn and sent back</b>. The app pre-picks "sent back" when enough of your payouts had reached your wallet by then, but the reports can't prove it either way, so check each one. ${help('Only days when the balance fell short are listed, so contracts paid from returned capital or profit never show here. Once added, a day disappears from this list. "Sent back" is taken off both money in and withdrawn; your net result is the same either way.')}</p>
    <form data-form="deposit-suggested">
      <div class="table-wrap"><table>
        <thead><tr><th><input type="checkbox" data-act="tick-all" title="Tick all"></th><th>Date</th><th>For contracts</th><th class="n">${u} needed</th><th class="n">USD</th><th class="n">Payouts in your wallet ${help('BTC paid out to your wallet by that day and not yet marked as sent back: the most this day could have been paid with withdrawn BTC.')}</th><th>It was</th></tr></thead>
        <tbody>${suggestions.map(s => `<tr><td><input type="checkbox" name="day" value="${s.date}"></td><td>${fmtDate(s.date)}</td>
          <td>${orderList(s.orders)}${s.partial.length ? `${s.orders.length ? ', ' : ''}part of ${orderList(s.partial)}` : ''}</td>
          <td class="n">${fmtAmt(s.btc)}</td><td class="n">${s.usd ? fmtMoney(s.usd) : '<span class="hint">estimate</span>'}</td>
          <td class="n">${s.avail > 0 ? fmtAmt(s.avail) : '—'}</td>
          <td><select name="as-${s.date}"><option value="new" ${s.pick === 'new' ? 'selected' : ''}>New money</option><option value="recycled" ${s.pick === 'recycled' ? 'selected' : ''} ${s.avail > 0 ? '' : 'disabled'}>Sent back from payouts</option></select></td></tr>`).join('')}</tbody>
      </table></div>
      <div class="inline" style="margin-top:8px"><button class="primary">Add the ticked days as deposits</button></div>
    </form>
  </details>` : ''}
  <form class="inline" data-form="deposit">
    <label>Date<input type="date" name="date" value="${todayIso()}" required></label>
    <label>BTC<input type="number" name="btc" step="0.00000001" min="0" style="width:150px" placeholder="from USD"></label>
    <label>USD/USDT paid<input type="number" name="usd" step="0.01" min="0" style="width:130px" placeholder="optional"></label>
    <label>Type<select name="kind"><option value="new">New BTC sent in</option><option value="recycled">Sent back from my payouts</option><option value="carry">Carried over from previous cycle</option></select></label>
    <label>Cycle${cycleSelect(defaultCycle)}</label>
    <label>Note<input name="note" style="width:220px"></label>
    <button class="primary">Add deposit</button>
  </form>
  <details class="panel" style="margin:10px 0">
    <summary><b>Add a deposit from orders you paid in USDT</b></summary>
    <p class="hint" style="margin-top:8px">Only for orders you paid from outside the platform, not from your balance. The exact BTC and USD are taken from the purchases report.</p>
    ${orderChoices.length ? `<form data-form="deposit-orders">
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>#</th><th>Bought</th><th class="n">TH/s</th><th class="n">BTC</th><th class="n">USD</th></tr></thead>
        <tbody>${orderChoices.map(p => `<tr><td><input type="checkbox" name="order" value="${p.num}"></td><td>${p.num}</td><td>${fmtDate(p.date)}</td>
          <td class="n">${p.th.toLocaleString('en-US')}</td><td class="n">${fmtAmt(p.allocBtc)}</td><td class="n">${fmtMoney(p.allocUsd)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="inline" style="margin-top:8px"><label>Cycle${cycleSelect(defaultCycle)}</label> <button class="primary">Add deposit for the ticked orders</button></div>
    </form>` : `<p class="hint">${needReimport ? 'Import the <b>hashrate purchases</b> report again to list your orders here.' : 'No orders left that aren\'t already part of a deposit.'}</p>`}
  </details>
  ${adminChoices.length ? `<details class="panel" style="margin:10px 0">
    <summary><b>Contracts added by the platform admin</b> <span class="hint">· ${adminChoices.length} not counted as money in</span></summary>
    <p class="hint" style="margin-top:8px">These contracts have 0 BTC allocated: they were added by hand, not bought from your balance. If you paid for them outside the platform (for example to the admin), tick them to add that as money in. It counts in your money in and net result, but not in your balance. The BTC is what the daily report charges back for each one; the USD is from its purchased line. Leave out any you didn't pay for.</p>
    <form data-form="deposit-admin">
      <div class="table-wrap"><table>
        <thead><tr><th></th><th>#</th><th>Contract</th><th>Added</th><th class="n">TH/s</th><th class="n">${u}</th><th class="n">USD paid</th><th></th></tr></thead>
        <tbody>${adminChoices.map(p => `<tr><td><input type="checkbox" name="order" value="${p.num}"></td><td>${p.num}</td><td>${esc(p.contractId)}</td><td>${fmtDate(p.date)}</td>
          <td class="n">${p.th.toLocaleString('en-US')}</td><td class="n">${fmtAmt(contractValue(p))}</td><td class="n">${p.paidUsd > 0 ? fmtMoney(p.paidUsd) : '—'}</td>
          <td class="hint">${idleInfo(p) ? 'no purchase line and not mining — only tick if you paid for it' : !(p.paidUsd > 0) ? 'no purchase line' : ''}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="inline" style="margin-top:8px"><label>Paid with<select name="kind"><option value="new">New money</option><option value="recycled">BTC I had withdrawn from the platform</option></select></label> <label>Cycle${cycleSelect(defaultCycle)}</label> <button class="primary">Add the ticked contracts</button></div>
    </form>
  </details>` : ''}` : `<div class="empty">Start a cycle first on the <b>Settings</b> tab.</div>`}
  ${deposits.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Cycle</th><th>Type</th><th class="n">${u}</th><th class="n">${cur} then</th><th class="n">${cur} now</th><th class="n">Change ${help('How much the value of that BTC has moved since, from the BTC price alone.')}</th><th>Note</th><th></th></tr></thead>
    <tbody>${deposits.map((d, i) => editing?.type === 'deposit' && editing.id === d.id
      ? `<tr data-edit="deposit" data-id="${d.id}"><td><input type="date" name="date" value="${d.date}"></td>
        <td>${cycleSelect(d.cycleId)}</td>
        <td><select name="kind"><option value="new" ${d.kind === 'new' || !d.kind ? 'selected' : ''}>New BTC</option><option value="recycled" ${d.kind === 'recycled' ? 'selected' : ''}>Sent back from payouts</option><option value="carry" ${d.kind === 'carry' ? 'selected' : ''}>Carried over</option></select></td>
        <td class="n"><input type="number" name="btc" step="0.00000001" min="0" value="${d.btc}" style="width:140px" title="BTC"></td>
        <td class="n"><input type="number" name="usd" step="0.01" min="0" value="${d.usd > 0 ? d.usd : ''}" style="width:110px" title="USD/USDT paid — leave empty to estimate" placeholder="estimate"></td><td></td><td></td>
        <td><input name="note" value="${esc(d.note)}" style="width:100%;min-width:200px"></td>
        <td class="actions"><button class="primary" data-act="save-edit">Save</button><button data-act="cancel-edit">Cancel</button></td></tr>`
      : `<tr><td>${fmtDate(d.date)}</td><td>${cycleName(d.cycleId)}</td><td>${d.kind === 'carry' ? 'Carried over' : d.kind === 'recycled' ? `Sent back ${help('BTC you had withdrawn to your wallet and sent back in to buy contracts. It is taken off both money in and withdrawn.')}` : d.outside ? `Paid outside ${help('Paid for contracts added by the admin. Counts as money in, but never reached your platform balance.')}` : 'New BTC'}</td>
        <td class="n">${fmtAmt(d.btc)}</td>${valueCells(depVals[i], d.btc, estDay)}<td class="note">${esc(d.note)}</td>
        <td class="actions"><button data-act="edit" data-type="deposit" data-id="${d.id}">Edit</button><button class="danger" data-act="del-deposit" data-id="${d.id}">Delete</button></td></tr>`).join('')}
    ${deposits.length > 1 ? `<tr class="total"><td colspan="3">Total (${deposits.length})</td><td class="n">${fmtAmt(sum(deposits, 'btc'))}</td>${valueCells(sumUsd(depVals), sum(deposits, 'btc'), 'Includes estimates.')}<td></td><td></td></tr>` : ''}</tbody>
  </table></div>` : ''}
  ${autoDeps.length ? `<p class="hint" style="margin-top:8px"><button class="danger" data-act="del-auto">Remove all ${plural(autoDeps.length, 'deposit')} added from the reports</button>
    ${help('Removes the deposits added from "Suggested money in", "Contracts added by the platform admin" and "Add a deposit from orders you paid in USDT" in this view. Deposits you typed in yourself stay. Use it to start those over, for example after importing the hashrate purchases report again.')}</p>` : ''}
  </div><div>

  <h2>Payouts to your wallet</h2>
  <p class="hint">From the payout report. "${cur} then" is estimated from the average BTC price on the day it was processed (marked ~).</p>
  ${payouts.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Requested</th><th>Processed</th><th class="n">Took</th><th>Status</th><th class="n">${u}</th><th class="n">${cur} then</th><th class="n">${cur} now</th><th class="n">Change</th><th>TX</th></tr></thead>
    <tbody>${payouts.map((p, i) => `<tr><td>${fmtDate(p.requested)}</td><td>${fmtDate(p.processed)}</td>
      <td class="n">${p.processed ? plural(daysBetween(p.requested, p.processed), 'day') : '—'}</td><td>${esc(p.status)}</td>
      <td class="n">${fmtAmt(p.btc)}</td>${valueCells(payVals[i], p.btc, estDay)}<td>${txCell(p.tx)}</td></tr>`).join('')}
    ${payouts.length > 1 ? `<tr class="total"><td colspan="4">Total (${payouts.length})</td><td class="n">${fmtAmt(sum(payouts, 'btc'))}</td>${valueCells(sumUsd(payVals), sum(payouts, 'btc'), 'Includes estimates.')}<td></td></tr>` : ''}</tbody>
  </table></div>` : `<div class="empty">No payouts yet.</div>`}

  ${renderSales()}

  <h2>Balance checks</h2>
  <p class="hint">Now and then, type in the available balance shown on the platform dashboard (in BTC). The app compares it with what the reports say it should be.</p>
  <form class="inline" data-form="check">
    <label>Date<input type="date" name="date" value="${todayIso()}" required></label>
    <label>Dashboard balance BTC<input type="number" name="btc" step="0.00000001" min="0" required style="width:150px"></label>
    <label>Note<input name="note" style="width:220px"></label>
    <button class="primary">Add check</button>
  </form>
  ${checks.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Earnings up to ${help('The latest day of imported earnings that the calculated balance includes. The platform settles each day early the next day, so a check usually lines up with the day before it.')}</th><th class="n">Dashboard (${u})</th><th class="n">Calculated</th><th class="n">Difference</th><th>Note</th><th></th></tr></thead>
    <tbody>${checks.map(c => {
      if (editing?.type === 'check' && editing.id === c.id) {
        return `<tr data-edit="check" data-id="${c.id}"><td><input type="date" name="date" value="${c.date}"></td><td></td>
          <td class="n"><input type="number" name="btc" step="0.00000001" min="0" value="${c.btc}" style="width:140px" title="BTC"></td><td></td><td></td>
          <td><input name="note" value="${esc(c.note)}" style="width:100%;min-width:160px"></td>
          <td class="actions"><button class="primary" data-act="save-edit">Save</button><button data-act="cancel-edit">Cancel</button></td></tr>`;
      }
      const calc = balanceAt(scope, c.date); const diff = c.btc - calc;
      const upTo = R.E.map(e => e.date).filter(d => d <= c.date).sort().at(-1);
      return `<tr><td>${fmtDate(c.date)}</td><td>${fmtDate(upTo)}</td>
      <td class="n">${fmtAmt(c.btc)}</td><td class="n">${fmtAmt(calc)}</td><td class="n ${Math.abs(diff) < 1e-6 ? 'pos' : 'warn'}">${fmtAmt(diff, true)}</td>
      <td class="note">${esc(c.note)}</td><td class="actions"><button data-act="edit" data-type="check" data-id="${c.id}">Edit</button><button class="danger" data-act="del-check" data-id="${c.id}">Delete</button></td></tr>`; }).join('')}</tbody>
  </table></div>` : ''}
  </div></div>`;
}

// ---------- your wallet: BTC sold for USDT and BTC still held ----------
// Payouts land in the wallet as lots. Sales (BTC sold for USDT) and BTC sent back to the platform use up
// the oldest lots first. What is left of a lot is still held as BTC, so it is worth today's price; a sold
// part is worth the USDT it fetched, for good. Everything in BTC stays as it is: this is the fiat side only.
function walletLedger() {
  const lots = data.payouts.filter(p => !isFailed(p.status))
    .map(p => ({ p, date: payoutDate(p), scope: cycleIdForDate(p.requested), btc: p.btc, left: p.btc })).sort(byDate);
  const uses = [
    ...(data.sales || []).map(s => ({ kind: 'sale', s, date: s.date, btc: s.btc, usd: s.usd })),
    ...data.deposits.filter(d => d.kind === 'recycled').map(d => ({ kind: 'back', d, date: d.date, btc: d.btc, scope: d.cycleId })),
  ].sort(byDate);
  const parts = [];
  for (const u of uses) {
    let need = u.btc;
    for (const l of lots) {
      if (need <= 1e-10) break;
      const t = Math.min(l.left, need);
      if (t <= 0) continue;
      l.left -= t; need -= t;
      parts.push({ lot: l, use: u, btc: t, usd: u.usd > 0 ? u.usd * t / u.btc : 0 });
    }
    u.unmatched = need > 1e-8 ? need : 0;
  }
  return { lots, uses, parts };
}

// Where the money stands in USD for a view. Money in at what it cost; sold BTC at the USDT it fetched;
// BTC still in the wallet and on the platform at today's price. Balance carried to the next cycle, and BTC
// sent back into another cycle, move at their value on that day (as money in for the cycle they went to).
function fiatPosition(R) {
  const { m } = R;
  const price = usdPrice();
  if (!R.D.length || !price) return null;
  const S = R.scope, inS = id => S === 'all' || id === S;
  const L = walletLedger();
  const nc = S === 'all' ? null : nextCycle(S);
  const carry = nc ? data.deposits.filter(d => d.cycleId === nc.id && d.kind === 'carry') : [];
  const inV = sumUsd(R.D.filter(d => d.kind !== 'recycled').map(depositUsd));
  const carryV = sumUsd(carry.map(depositUsd));
  const sales = L.parts.filter(x => x.use.kind === 'sale' && inS(x.lot.scope));
  const soldBtc = sum(sales, 'btc'), soldUsd = sum(sales, 'usd');
  const heldBtc = sum(L.lots.filter(l => inS(l.scope)), 'left');
  const moved = [];
  if (S !== 'all') {
    for (const x of L.parts.filter(x => x.use.kind === 'back')) {
      const fromHere = x.lot.scope === S, toHere = x.use.scope === S;
      if (fromHere === toHere) continue;
      const v = depositUsd(x.use.d);
      moved.push({ usd: (fromHere ? 1 : -1) * v.usd * x.btc / x.use.btc, est: v.est });
    }
  }
  const movedV = sumUsd(moved);
  const left = m.onPlatform * price;
  const worth = soldUsd + heldBtc * price + left + carryV.usd + movedV.usd;
  const result = worth - inV.usd;
  const mining = m.net * price;
  const saleEffect = soldUsd - soldBtc * price;
  return {
    price, inV, carryV, soldBtc, soldUsd, heldBtc, held: heldBtc * price, left, worth, result, mining, saleEffect,
    priceEffect: result - mining - saleEffect, est: inV.est || carryV.est || movedV.est,
    unmatched: sum(L.uses.filter(u => u.kind === 'sale'), 'unmatched'),
  };
}

// Sales of payout BTC for USDT. Not tied to a cycle: they use up the oldest payouts first.
function renderSales() {
  const sales = (data.sales || []).slice().sort(byDate);
  const L = walletLedger();
  const price = usdPrice();
  const held = sum(L.lots, 'left');
  const over = sum(L.uses.filter(u => u.kind === 'sale'), 'unmatched');
  const row = s => {
    const now = price ? s.btc * price : NaN, diff = s.usd - now;
    return `<tr><td>${fmtDate(s.date)}</td><td class="n">${fmtAmt(s.btc)}</td><td class="n">${fmtMoney(s.usd)}</td>
      <td class="n">${fmtMoney(s.usd / s.btc)}</td><td class="n">${isFinite(now) ? fmtMoney(now) : '—'}</td><td class="n ${tone(diff)}">${isFinite(diff) ? (diff > 0.005 ? '+' : '') + fmtMoney(diff) : '—'}</td>
      <td class="note">${esc(s.note)}</td><td class="actions"><button class="danger" data-act="del-sale" data-id="${s.id}">Delete</button></td></tr>`;
  };
  return `<h2>Sold for USDT</h2>
  <p class="hint">When you sell payout BTC for USDT, record it here, so your result in ${prefs.currency} counts what it fetched instead of today's price. Sales use up your oldest payouts first. Your BTC figures don't change. ${help('A sale only changes the fiat side: the payouts still count as withdrawn in BTC. Type the USDT you actually received, after any fees.')}</p>
  <form class="inline" data-form="sale">
    <label>Date<input type="date" name="date" value="${todayIso()}" required></label>
    <label>BTC sold<input type="number" name="btc" step="0.00000001" min="0" required style="width:150px"></label>
    <label>USDT received<input type="number" name="usd" step="0.01" min="0" required style="width:130px"></label>
    <label>Note<input name="note" style="width:200px"></label>
    <button class="primary">Add sale</button>
  </form>
  <p class="hint" style="margin-top:8px">BTC from payouts still in your wallet: <b>${fmtAmtU(held)}</b>${price ? ` (${fmtMoney(held * price)} today)` : ''}.</p>
  ${over > 0 ? `<div class="alert warn" style="margin:8px 0">⚠ <span>Your sales add up to ${fmtAmtU(over)} more than your payouts. Check the amounts; BTC that didn't come from the platform doesn't belong here.</span></div>` : ''}
  ${sales.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th class="n">BTC</th><th class="n">USDT</th><th class="n">Price</th><th class="n">${prefs.currency} now ${help('The same BTC at today\'s price.')}</th><th class="n">Difference ${help('What the sale fetched minus what that BTC would be worth today. Positive: you sold higher than today.')}</th><th>Note</th><th></th></tr></thead>
    <tbody>${sales.map(row).join('')}
    ${sales.length > 1 ? (() => { const b = sum(sales, 'btc'), u = sum(sales, 'usd'), now = price ? b * price : NaN; return `<tr class="total"><td>Total (${sales.length})</td><td class="n">${fmtAmt(b)}</td><td class="n">${fmtMoney(u)}</td><td class="n">${fmtMoney(u / b)}</td><td class="n">${isFinite(now) ? fmtMoney(now) : '—'}</td><td class="n ${tone(u - now)}">${isFinite(now) ? ((u - now) > 0.005 ? '+' : '') + fmtMoney(u - now) : '—'}</td><td></td><td></td></tr>`; })() : ''}</tbody>
  </table></div>` : ''}`;
}

// The result in USD/AED.
function renderFiatResult(R) {
  const F = fiatPosition(R);
  if (!F) return '';
  const { m } = R, est = F.est;
  // ~ marks a figure that includes estimates
  const t = (v, e = est) => (isFinite(v) ? (e ? '~' : '') + fmtMoney(v) : '—');
  const sign = (v, e = est) => (isFinite(v) && v > 0.005 ? (e ? '~+' : '+') + fmtMoney(v) : t(v, e));
  const ok = isFinite(F.result);
  return `<h2>Your result in ${prefs.currency}</h2>
  <div class="grid">
    ${card('Money in', 0, { text: t(F.inV.usd, F.inV.est), help: 'Your deposits, valued on the day you sent them: the USD/USDT you paid, else that day\'s average BTC price.', sub: fmtAmtU(m.in) })}
    ${F.soldBtc > 0 ? card('Sold for USDT', 0, { text: fmtMoney(F.soldUsd), help: 'Payouts you sold for USDT, at what you got for them. This amount is fixed: it no longer moves with the BTC price.', sub: fmtAmtU(F.soldBtc) }) : ''}
    ${card('BTC in your wallet', 0, { text: fmtMoney(F.held), help: 'Payouts you haven\'t recorded as sold (or sent back), at today\'s BTC price. Record a sale below when you sell some for USDT.', sub: fmtAmtU(F.heldBtc) })}
    ${card('Still on the platform', 0, { text: fmtMoney(F.left + F.carryV.usd), help: 'Your balance and the capital still in contracts, at today\'s BTC price.' + (F.carryV.usd ? ' Plus the balance carried to the next cycle, at its value on that day.' : ''), sub: fmtAmtU(m.onPlatform + m.carriedOut) })}
    ${card('Result', 0, { text: sign(F.result), tone: tone(F.result), help: `What you have now (sold + in your wallet + on the platform) − money in, all in ${prefs.currency}.`, sub: ok && F.inV.usd > 0 ? `${fmtPct(F.result / F.inV.usd, 2, true)} of money in` : '' })}
  </div>
  ${ok ? `<p class="hint" style="margin-top:8px">Of which <b>from mining</b>: ${sign(F.mining, false)} (your net ${fmtAmtU(m.net, true)} at today's price) · <b>from the BTC price moving</b>: ${sign(F.priceEffect)}${F.soldBtc > 0 ? ` · <b>from when you sold</b>: ${sign(F.saleEffect, false)} ${help('What your sales fetched compared with the same BTC at today\'s price. Positive: you sold higher than today.')}` : ''}.${est ? ' ~ = includes estimates from daily average prices.' : ''}</p>` : '<p class="hint" style="margin-top:8px">Waiting for the BTC prices of those days (this needs an internet connection).</p>'}`;
}

// What belongs to a cycle by date, and what is dated before the first cycle (so no cycle view shows it).
function cycleContents(id) {
  const inC = d => cycleIdForDate(d) === id;
  return {
    contracts: data.purchases.filter(p => inC(p.date)).length,
    days: new Set(data.earnings.filter(e => inC(e.date)).map(e => e.date)).size,
    payouts: data.payouts.filter(p => inC(p.requested)).length,
    deposits: data.deposits.filter(d => d.cycleId === id).length,
  };
}
function hiddenBeforeFirstCycle() {
  const first = cyclesSorted()[0];
  if (!first) return null;
  const before = d => d < first.start;
  const days = new Set(data.earnings.filter(e => before(e.date)).map(e => e.date)).size;
  const contracts = data.purchases.filter(p => before(p.date)).length;
  const payouts = data.payouts.filter(p => before(p.requested)).length;
  if (!days && !contracts && !payouts) return null;
  const parts = [days && plural(days, 'day') + ' of earnings', contracts && plural(contracts, 'contract'), payouts && plural(payouts, 'payout')].filter(Boolean);
  return `${parts.join(', ')} ${days + contracts + payouts === 1 ? 'is' : 'are'} dated before your first cycle, <b>${esc(first.name)}</b>, starts (${fmtDate(first.start)}), so no cycle view shows them. Change its start date on the <b>Settings</b> tab, or switch <b>View</b> to "All time".`;
}

// A cycle's auto-reinvest and payout, as set on the platform. The app only uses them for its calculations.
function platformPanel(c) {
  const bp = blockPriceInfo(c);
  const th = c.blockTh || MIN_BLOCK_TH;
  const cost = bp ? blockCost(th, bp.price) : NaN;
  const opts = (map, v) => Object.entries(map).map(([k, l]) => `<option value="${k}" ${k === (v || 'off') ? 'selected' : ''}>${l}</option>`).join('');
  const notes = [];
  if (c.withdrawThreshold != null && c.withdrawThreshold < MIN_PAYOUT) notes.push(`The platform's smallest payout is ${MIN_PAYOUT} BTC.`);
  const r = c.reinvestFrom, p = c.payoutFrom;
  const overlap = (r === 'both' && p && p !== 'off') || (r === 'capital' && (p === 'capital' || p === 'everything')) || (r === 'profit' && (p === 'profit' || p === 'everything'));
  if (overlap) notes.push('Reinvest and payout both use the same money; check which one the platform applies first.');
  return `<form class="panel" data-form="cycle-settings" data-cycle="${c.id}" style="margin-top:10px">
    <div style="margin-bottom:8px"><b>${esc(c.name)}</b>: auto-reinvest and payout ${help('Copy what you set on the platform. The app uses these for the Projection tab and checks the platform\'s auto-reinvest buys and payouts against them; it never changes anything on the platform.')}</div>
    <div class="inline">
      <label>Reinvest from<select name="reinvestFrom">${opts(REINVEST_FROM, c.reinvestFrom)}</select></label>
      <label>Block size (TH/s)<input type="number" name="blockTh" min="${MIN_BLOCK_TH}" step="1" value="${c.blockTh ?? ''}" placeholder="${MIN_BLOCK_TH}" style="width:100px"></label>
      <label>Block price (BTC per TH per day)<input type="number" name="blockPrice" min="0" step="0.000000000001" value="${c.blockPrice > 0 ? c.blockPrice.toFixed(12) : ''}" placeholder="${bp && !(c.blockPrice > 0) ? bp.price.toFixed(12) : 'from your latest contract'}" style="width:180px"></label>
      <label>Pay out<select name="payoutFrom">${opts(PAYOUT_FROM, c.payoutFrom)}</select></label>
      <label>Pay out when it reaches (BTC)<input type="number" name="withdrawThreshold" min="0" step="0.00000001" value="${c.withdrawThreshold ?? ''}" placeholder="${MIN_PAYOUT}" style="width:120px"></label>
    </div>
    <div class="hint" style="margin:8px 0 0">${bp ? `One block of ${th.toLocaleString('en-US')} TH/s costs <b>${fmtAmtU(cost)}</b>${fiat(cost) ? ` (${fiat(cost)})` : ''} at ${bp.price.toFixed(12)} BTC per TH per day, <span class="${bp.stale ? 'warn' : ''}">${esc(bp.src)}${bp.stale && bp.age != null ? ` (${plural(bp.age, 'day')} old)` : ''}</span>.` : 'Import the hashrate purchases report, or type the block price from the platform.'}
      Leave the block price empty to use your latest contract's price; type the rate from the platform's reinvest page when it's newer.</div>
    ${notes.map(n => `<div class="hint warn" style="margin:4px 0 0">⚠ ${n}</div>`).join('')}
    ${checkSummary(c)}
  </form>`;
}

function renderSettings() {
  const cs = cyclesSorted();
  const counts = `${plural(data.purchases.length, 'contract')} · ${plural(new Set(data.earnings.map(e => e.date)).size, 'day')} of earnings · ${plural(data.payouts.length, 'payout')} · ${data.summaries.length} contract results`;
  const seg = (pref, opts) => `<div class="seg" data-pref="${pref}">${opts.map(([v, l]) => `<button data-v="${v}" class="${prefs[pref] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const hidden = hiddenBeforeFirstCycle();
  const lastCycle = cs.at(-1);
  const leftover = lastCycle ? compute(lastCycle.id).m.balance : 0;
  const lastEarn = [...data.earnings].sort(byDate).at(-1)?.date;
  const when = iso => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const contentsText = c => {
    const n = cycleContents(c.id);
    const parts = [n.contracts && plural(n.contracts, 'contract'), n.days && plural(n.days, 'day') + ' of earnings', n.payouts && plural(n.payouts, 'payout'), n.deposits && plural(n.deposits, 'deposit')].filter(Boolean);
    return parts.length ? parts.join(' · ') : '<span class="warn">Nothing yet</span>';
  };
  return `<div class="cols"><div>
  <h2>Cycles</h2>
  <p class="hint">A cycle is one run of the loop, starting from a fresh contract. Everything dated on or after a cycle's start date (and before the next cycle's start) belongs to it. Changes here are saved straight away.</p>
  ${hidden ? `<div class="alert warn" style="margin-bottom:10px">⚠ <span>${hidden}</span></div>` : ''}
  ${cs.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Start</th><th>Contains</th><th>Notes</th><th></th></tr></thead>
    <tbody>${cs.map(c => `<tr data-cycle="${c.id}">
      <td><input name="name" value="${esc(c.name)}" style="width:110px"></td>
      <td><input type="date" name="start" value="${c.start}"></td>
      <td class="note" style="min-width:150px;max-width:190px">${contentsText(c)}</td>
      <td><input name="notes" value="${esc(c.notes)}" style="width:100%;min-width:200px"></td>
      <td class="actions"><button class="danger" data-act="del-cycle" data-id="${c.id}">Delete</button></td></tr>`).join('')}</tbody>
  </table></div>` : ''}
  ${cs.slice().reverse().map(platformPanel).join('')}

  <h2>Start a new cycle</h2>
  <p class="hint">Set the start date to the day of the first new contract. If the previous cycle's contracts are still paying out, wait until they've ended so their last payouts stay in that cycle.${leftover > 0 ? ` "Carried over" is filled in with ${esc(lastCycle.name)}'s calculated balance; check it against your dashboard.` : ''}</p>
  <form class="inline" data-form="cycle">
    <label>Name<input name="name" value="Cycle ${cs.filter(c => !/test/i.test(c.name)).length + 1}" required style="width:140px"></label>
    <label>Start date<input type="date" name="start" value="${todayIso()}" required></label>
    <label>Carried over BTC<input type="number" name="carry" step="0.00000001" min="0" style="width:140px" placeholder="0" value="${leftover > 0 ? leftover.toFixed(8) : ''}"></label>
    <label>New BTC sent in<input type="number" name="fresh" step="0.00000001" min="0" style="width:140px" placeholder="0"></label>
    <label>USD/USDT paid for it (optional)<input type="number" name="freshUsd" step="0.01" min="0" style="width:130px"></label>
    <button class="primary">Create cycle</button>
  </form>
  <p class="hint" style="margin-top:8px">Once it's created, fill in its auto-reinvest and payout settings above.</p>

  <h2>Display</h2>
  <div class="panel prefs">
    <div><span>Amounts</span>${seg('unit', [['btc', 'BTC'], ['sats', 'sats']])}</div>
    <div><span>Currency</span>${seg('currency', [['USD', 'USD'], ['AED', 'AED']])}</div>
    <div><span>Theme</span>${seg('theme', [['auto', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']])}</div>
  </div>
  </div><div>

  <h2>Data</h2>
  <div class="panel">
    <div>${fileState === 'connected' ? `Saving to <b>${esc(dirHandle.name)}\\${DATA_FILE}</b>${backupCount != null ? ` · ${plural(backupCount, 'daily backup')} in <b>${esc(dirHandle.name)}\\backups</b> (last ${KEEP_BACKUPS} days kept)` : ''}.` : 'Not connected to a data folder.'}</div>
    <div class="hint" style="margin:6px 0 0">${counts}.</div>
    <div class="hint" style="margin:4px 0 0">Last saved ${when(data.savedAt)} · last import ${when(data.lastImport?.at)} · daily earnings up to ${fmtDate(lastEarn)}.</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
      <button data-act="open-folder">${fileState === 'connected' ? 'Change data folder' : 'Choose data folder'}</button>
      <button data-act="export">Export backup</button>
      <button data-act="import-backup">Restore backup…</button>
      <input id="backupInput" type="file" accept=".json" hidden>
      <button class="danger" data-act="reset">Reset all data…</button>
    </div>
  </div>

  <h2>How to use</h2>
  <div class="panel"><ol class="steps">
    <li>On the platform, download the <b>daily earnings</b>, <b>hashrate purchases</b> and <b>payout</b> reports (plus <b>profit-capital</b> if you want results per contract).</li>
    <li>Click <b>Import reports</b> or drag the CSVs onto this page. Importing the same report twice is safe — rows are refreshed, not doubled. Reinvestments come in automatically with the purchases report.</li>
    <li>Record the money you send in on the <b>Money in &amp; out</b> tab — reports don't show deposits. If you paid for orders in USDT, use <b>Add a deposit from orders you paid in USDT</b> there, so the exact BTC and USD come from the report.</li>
    <li>A contract's cost is the BTC allocated to it. On orders paid in USDT, the report's "purchased" BTC is only the USD converted at one rate for the whole report, so the app ignores it.</li>
    <li>A contract with 0 BTC allocated was added by the platform admin. The app values it at what the daily report charges back for it and lists it on the Money in &amp; out tab, so you can add what you paid for it outside the platform.</li>
    <li>If the report's hashrate leaves out a contract on record for most of its days while still taking its capital back, the app warns about it and shows the returns both ways: as the platform reports them, and without that contract.</li>
    <li>"Suggested money in" replays the platform balance day by day from the reports. On days a contract cost more than the balance had, the difference must have come in from outside: new money, or BTC you had withdrawn and sent back. Mark the second kind "Sent back from payouts": it is taken off both money in and withdrawn, so those figures show what really came from your pocket and what really stayed in your wallet.</li>
    <li>Now and then add a <b>balance check</b> from the dashboard to confirm the numbers line up. The platform settles each day early the next day, so a check usually matches the earnings up to the day before.</li>
  </ol>
  <p class="hint" style="margin:10px 0 0">Your data never leaves this computer. The app only fetches BTC prices from the internet: today's, and the daily averages for estimates. Version ${APP_VERSION}.</p></div>
  </div></div>`;
}

// ---------- sortable tables ----------
function applySort(table) {
  const st = sortState[table.dataset.sortId];
  const ths = [...table.tHead.rows[0].cells];
  ths.forEach((th, i) => {
    th.classList.add('sortable');
    th.classList.toggle('asc', st?.col === i && st.dir === 1);
    th.classList.toggle('desc', st?.col === i && st.dir === -1);
  });
  if (!st) return;
  const tb = table.tBodies[0];
  const all = [...tb.rows];
  const rows = all.filter(r => !r.classList.contains('total'));
  const totals = all.filter(r => r.classList.contains('total'));
  const val = r => {
    const c = r.cells[st.col];
    const raw = c?.dataset.v ?? c?.textContent ?? '';
    const n = Number(raw);
    return raw !== '' && !isNaN(n) ? n : raw;
  };
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * st.dir;
    return String(x).localeCompare(String(y)) * st.dir;
  });
  tb.append(...rows, ...totals);
}

// ---------- persistence ----------
const IDB = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('cloud-mining', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  },
  get(k) { return this.run('readonly', s => s.get(k)); },
  set(k, v) { return this.run('readwrite', s => s.put(v, k)); },
};

let saveTimer = null;
let writeChain = Promise.resolve();
function save() {
  data.savedAt = new Date().toISOString();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, folder: dirHandle?.name || null })); } catch { /* storage full or blocked */ }
  if (dirHandle && fileState === 'connected') {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { writeChain = writeChain.then(writeData); }, 250);
  }
}
async function writeData() {
  try {
    const fh = await dirHandle.getFileHandle(DATA_FILE, { create: true });
    await backupOnce(fh);
    const w = await fh.createWritable();
    await w.write(JSON.stringify(data, null, 1));
    await w.close();
  } catch (e) {
    fileState = 'reconnect';
    toast('Could not save to the data folder: ' + e.message, true);
    renderBanner();
  }
}
// Once a day, before the first save, copy the current file into backups/ and keep the last KEEP_BACKUPS.
async function backupOnce(fh) {
  const today = todayIso();
  if (backupDoneFor === today) return;
  const bdir = await dirHandle.getDirectoryHandle('backups', { create: true });
  const name = `cloud-mining-${today}.json`;
  let exists = true;
  try { await bdir.getFileHandle(name); } catch { exists = false; }
  if (!exists) {
    const prev = await (await fh.getFile()).text();
    if (prev.trim()) {
      const w = await (await bdir.getFileHandle(name, { create: true })).createWritable();
      await w.write(prev);
      await w.close();
    }
  }
  const names = [];
  for await (const [n, h] of bdir.entries()) if (h.kind === 'file' && /^cloud-mining-\d{4}-\d{2}-\d{2}\.json$/.test(n)) names.push(n);
  names.sort();
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) await bdir.removeEntry(n);
  backupCount = Math.min(names.length, KEEP_BACKUPS);
  backupDoneFor = today;
}
async function countBackups() {
  try {
    const bdir = await dirHandle.getDirectoryHandle('backups');
    let n = 0;
    for await (const [name] of bdir.entries()) if (/^cloud-mining-\d{4}-\d{2}-\d{2}\.json$/.test(name)) n++;
    backupCount = n;
  } catch { backupCount = 0; }
}
async function loadFromFolder() {
  let fh = null;
  try { fh = await dirHandle.getFileHandle(DATA_FILE); } catch { /* new folder */ }
  const text = fh ? await (await fh.getFile()).text() : '';
  let local = null;
  try { local = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* ignore */ }
  if (text.trim()) {
    const fromFile = JSON.parse(text);
    // Keep edits made here while the folder was disconnected, if they are newer than the file.
    const localNewer = local?.savedAt && fromFile.savedAt && local.savedAt > fromFile.savedAt && local.folder === dirHandle.name;
    data = migrate(localNewer ? local : fromFile);
  } // else: an empty/new folder starts with whatever is in this browser now
  fileState = 'connected';
  await countBackups();
  save();
}
async function openFolder() {
  try {
    const picked = await window.showDirectoryPicker({ id: 'cloud-mining', mode: 'readwrite' });
    if ((await picked.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to save was not given.');
    let hasFile = true;
    try { await picked.getFileHandle(DATA_FILE); } catch { hasFile = false; }
    const hasLocal = data.earnings.length || data.purchases.length || data.cycles.length;
    if (hasFile && hasLocal && !confirm(`This folder already has ${DATA_FILE}. Load it? (The data currently in the app will be replaced by the file.)`)) return;
    dirHandle = picked;
    backupDoneFor = null;
    await IDB.set('dirHandle', dirHandle);
    if (hasFile) localStorage.removeItem(STORAGE_KEY); // the folder's file is the source of truth
    await loadFromFolder();
    toast(hasFile ? `Loaded ${DATA_FILE} from ${dirHandle.name}` : `Saving to ${dirHandle.name}\\${DATA_FILE}`);
  } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
  render();
}
async function reconnect() {
  try {
    if ((await dirHandle.requestPermission({ mode: 'readwrite' })) === 'granted') await loadFromFolder();
  } catch (e) { toast(e.message, true); }
  render();
}
// Reset: move the data file and backups/ into resets/reset-YYYY-MM-DD_HHMM/ (with a note saying what
// was in it), then start empty. Without a folder, the current data is downloaded instead.
async function resetData() {
  const counts = `${plural(data.purchases.length, 'contract')}, ${plural(new Set(data.earnings.map(e => e.date)).size, 'day')} of earnings, ${plural(data.payouts.length, 'payout')}, ${plural(data.cycles.length, 'cycle')} and ${plural(data.deposits.length, 'deposit')}`;
  const where = fileState === 'connected'
    ? `${DATA_FILE} and its backups will be moved to ${dirHandle.name}\\resets\\ in a folder named after today's date and time.`
    : 'A copy of the current data will be downloaded first.';
  if (!confirm(`Reset all data and start fresh?\n\nThis clears ${counts}. ${where}\n\nYour display settings are kept.`)) return;
  const now = new Date();
  const stamp = `${todayIso()}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  try {
    if (fileState === 'connected') {
      clearTimeout(saveTimer);
      await writeChain;
      const resets = await dirHandle.getDirectoryHandle('resets', { create: true });
      let name = `reset-${stamp}`;
      for (let i = 2; await resets.getDirectoryHandle(name).then(() => true, () => false); i++) name = `reset-${stamp}-${i}`;
      const dest = await resets.getDirectoryHandle(name, { create: true });
      await writeText(dest, 'about-this-reset.txt', `Reset on ${now.toString()} by Cloud Mining Tracker ${APP_VERSION}.\r\nThis folder holds the data file and backups as they were just before the reset: ${counts}.\r\nTo go back to this data, use Settings > Restore backup and pick the ${DATA_FILE} in this folder.\r\n`);
      try { await moveFile(dirHandle, DATA_FILE, dest); } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      try {
        const src = await dirHandle.getDirectoryHandle('backups');
        const bdest = await dest.getDirectoryHandle('backups', { create: true });
        const names = [];
        for await (const [n, h] of src.entries()) if (h.kind === 'file') names.push(n);
        for (const n of names) await moveFile(src, n, bdest);
        await dirHandle.removeEntry('backups'); // empty now; fails safely if anything was left
      } catch (e) { if (e.name !== 'NotFoundError') throw e; }
      toast(`Data reset. The old data is in ${dirHandle.name}\\resets\\${name}`);
    } else {
      exportBackup(`cloud-mining-before-reset-${stamp}.json`);
      toast('Data reset. A copy of the old data was downloaded.');
    }
  } catch (e) {
    toast('Reset stopped, nothing was cleared: ' + e.message, true);
    return;
  }
  data = emptyData();
  currentScope = null;
  editing = null;
  backupDoneFor = null;
  backupCount = 0;
  currentTab = 'overview';
  save();
  render();
}
async function writeText(dir, name, text) {
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
}
// Copy then delete, which works in every browser with folder access (FileSystemHandle.move() doesn't yet).
async function moveFile(fromDir, name, toDir) {
  const text = await (await (await fromDir.getFileHandle(name)).getFile()).text();
  await writeText(toDir, name, text);
  await fromDir.removeEntry(name);
}
function exportBackup(filename) {
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename || `cloud-mining-backup-${todayIso()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- daily average prices (for contracts without a USD figure) ----------
const dayPrices = {}; // date → average BTC/USD of that day (UTC), null if none was found
let dayPricesBusy = false;
async function fetchDayPrices() {
  const dates = [
    ...data.purchases.filter(p => !(p.allocUsd > 0)).map(p => p.date),
    ...data.deposits.filter(d => !(d.usd > 0)).map(d => d.date),
    ...data.payouts.map(payoutDate),
  ];
  const need = [...new Set(dates)].filter(d => isIso(d) && !(d in dayPrices) && d <= todayIso()).sort();
  if (!need.length || dayPricesBusy) return;
  dayPricesBusy = true;
  try {
    // Coinbase returns up to 300 daily candles per request: [time, low, high, open, close, volume]
    for (let i = 0; i < need.length;) {
      const from = need[i], to = addDays(from, 299);
      const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${from}T00:00:00Z&end=${to}T00:00:00Z`;
      const candles = await (await fetch(url)).json();
      const byDay = new Map(candles.map(([t, lo, hi, op, cl]) => [new Date(t * 1000).toISOString().slice(0, 10), (lo + hi + op + cl) / 4]));
      for (; i < need.length && need[i] <= to; i++) dayPrices[need[i]] = byDay.get(need[i]) ?? null;
    }
    if (['overview', 'contracts', 'money'].includes(currentTab) && !document.activeElement?.closest('form, tr[data-edit]')) render();
  } catch { /* offline: those amounts show — until the next try */ }
  finally { dayPricesBusy = false; }
}

// USD value of money moving in or out, on the day it moved: what the user typed, else that day's average price.
const payoutDate = p => p.processed || p.requested;
function depositUsd(d) {
  if (d.usd > 0) return { usd: d.usd, est: false };
  const price = dayPrices[d.date];
  return price > 0 ? { usd: d.btc * price, est: true } : { usd: NaN, est: false };
}
// BTC for a USD amount on a given day: that day's average price, else the report's price that day,
// else today's live price (for today only). null if none can be found.
async function usdToBtc(usd, date) {
  if (!(dayPrices[date] > 0) && date <= todayIso()) {
    try {
      const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&start=${date}T00:00:00Z&end=${addDays(date, 1)}T00:00:00Z`;
      const hit = (await (await fetch(url)).json()).find(([t]) => new Date(t * 1000).toISOString().slice(0, 10) === date);
      if (hit) { const [, lo, hi, op, cl] = hit; dayPrices[date] = (lo + hi + op + cl) / 4; }
    } catch { /* offline */ }
  }
  const rep = data.earnings.find(e => e.date === date && e.btcUsd > 0)?.btcUsd;
  const [price, src] = dayPrices[date] > 0 ? [dayPrices[date], `the ${fmtDate(date)} average of ${fmtMoney(dayPrices[date])}`]
    : rep ? [rep, `the report's price that day (${fmtMoney(rep)})`]
    : date === todayIso() && btcUsd ? [btcUsd, `today's price (${fmtMoney(btcUsd)})`] : [null, ''];
  return price ? { btc: +(usd / price).toFixed(8), src } : null;
}
function payoutUsd(p) {
  const price = dayPrices[payoutDate(p)];
  return price > 0 ? { usd: p.btc * price, est: true } : { usd: NaN, est: false };
}
// Totals of {usd, est} values: NaN if any is unknown, an estimate if any part is.
function sumUsd(vals) {
  return { usd: vals.some(v => !isFinite(v.usd)) ? NaN : sum(vals, 'usd'), est: vals.some(v => v.est) };
}
const fmtUsdVal = (v, title) => (!isFinite(v.usd) ? '—' : v.est ? `<span title="${esc(title)}">~${fmtMoney(v.usd)}</span>` : fmtMoney(v.usd));

// ---------- live price ----------
async function fetchPrice() {
  const sources = [
    async () => +(await (await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot')).json()).data.amount,
    async () => +(await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd')).json()).bitcoin.usd,
  ];
  for (const src of sources) {
    try {
      const v = await src();
      if (v > 0) {
        const changed = v !== btcUsd;
        btcUsd = v;
        // avoid wiping a half-typed form; the next render picks the price up
        if (changed && !document.activeElement?.closest('form, tr[data-edit]')) render();
        return;
      }
    } catch { /* try next source */ }
  }
}

// ---------- events ----------
function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), err ? 9000 : 5000);
}

function bind() {
  addEventListener('resize', moveTabInk);
  document.fonts?.ready.then(moveTabInk);
  // Remember open/closed <details data-fold="…"> sections per browser, like the other display prefs.
  document.addEventListener('toggle', e => {
    const f = e.target.dataset?.fold;
    if (!f) return;
    prefs[f] = e.target.open;
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, true);
  $('#tabs').addEventListener('click', e => {
    const t = e.target.closest('button[data-tab]');
    if (t) { currentTab = t.dataset.tab; editing = null; render(); }
  });
  $('#scope').addEventListener('change', e => { currentScope = e.target.value; resetProj(); render(); });
  $('#importBtn').addEventListener('click', () => $('#importInput').click());
  $('#importInput').addEventListener('change', e => { importFiles([...e.target.files]); e.target.value = ''; });

  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; $('#dropzone').hidden = false; } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropzone').hidden = true; } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true;
    const files = [...e.dataTransfer.files];
    const csvs = files.filter(f => /\.csv$/i.test(f.name));
    if (csvs.length < files.length) toast('Only CSV files can be imported — others were ignored.', true);
    if (csvs.length) importFiles(csvs);
  });

  document.addEventListener('click', async e => {
    const segBtn = e.target.closest('.seg[data-pref] button');
    if (segBtn) { setPref(segBtn.closest('.seg').dataset.pref, segBtn.dataset.v); return; }
    const th = e.target.closest('table[data-sort-id] thead th');
    if (th) {
      const id = th.closest('table').dataset.sortId;
      const col = th.cellIndex;
      const st = sortState[id];
      sortState[id] = st?.col === col ? { col, dir: -st.dir } : { col, dir: 1 };
      applySort(th.closest('table'));
      return;
    }
    const b = e.target.closest('[data-act]');
    if (b?.dataset.act === 'tick-all') { b.closest('form').querySelectorAll('input[name="day"]').forEach(i => { i.checked = b.checked; }); return; }
    if (!b || b.tagName === 'INPUT') return;
    const act = b.dataset.act, id = b.dataset.id;
    if (act === 'open-folder') openFolder();
    else if (act === 'reconnect') reconnect();
    else if (act === 'export') exportBackup();
    else if (act === 'reset') { resetData(); return; }
    else if (act === 'import') $('#importInput').click();
    else if (act === 'import-backup') $('#backupInput').click();
    else if (act === 'dismiss-import') { data.lastImport = null; save(); render(); }
    else if (act === 'ov-chart') setPref('ovChart', b.dataset.v);
    else if (act === 'run-win') setPref('runWin', b.dataset.v);
    else if (act === 'hide-notes') setPref('notesHidden', todayIso());
    else if (act === 'hide-banner') setPref('bannerHidden', todayIso());
    else if (act === 'toggle-month') { const ym = b.dataset.ym; collapsedMonths.has(ym) ? collapsedMonths.delete(ym) : collapsedMonths.add(ym); render(); }
    else if (act === 'proj-reset') { resetProj(); render(); }
    else if (act === 'edit') { editing = { type: b.dataset.type, id }; render(); }
    else if (act === 'cancel-edit') { editing = null; render(); }
    else if (act === 'save-edit') {
      const tr = b.closest('tr[data-edit]');
      const v = Object.fromEntries([...tr.querySelectorAll('[name]')].map(i => [i.name, i.value]));
      if (tr.dataset.edit === 'deposit' && isIso(v.date) && v.btc.trim() === '' && num(v.usd) > 0) {
        const r = await usdToBtc(num(v.usd), v.date);
        if (!r) { toast(`No BTC price found for ${fmtDate(v.date)}. Type the BTC amount instead.`, true); return; }
        v.btc = String(r.btc);
      }
      if (!isIso(v.date) || !(num(v.btc) >= 0)) { toast('Enter a valid date and BTC amount.', true); return; }
      const list = tr.dataset.edit === 'deposit' ? data.deposits : data.balanceChecks;
      const rec = list.find(x => x.id === tr.dataset.id);
      Object.assign(rec, { date: v.date, btc: num(v.btc), note: v.note.trim() });
      if (v.kind) rec.kind = v.kind;
      if (v.cycleId) rec.cycleId = v.cycleId;
      if ('usd' in v) rec.usd = num(v.usd) > 0 ? num(v.usd) : null;
      editing = null; save(); render(); toast('Saved');
    }
    else if (act === 'leave-out') {
      const p = data.purchases.find(x => x.num === +b.dataset.num);
      const on = b.dataset.v === 'out';
      if (p && !!p.leaveOut !== on) {
        if (on) p.leaveOut = true; else delete p.leaveOut;
        save(); render();
        toast(on ? `${p.contractId} is left out of returns and profit` : `${p.contractId} is counted again, as the platform reports it`);
      }
    }
    else if (act === 'del-auto') {
      const gone = data.deposits.filter(d => isFromReports(d) && (currentScope === 'all' || d.cycleId === currentScope));
      if (gone.length && confirm(`Remove ${plural(gone.length, 'deposit')} added from the reports (${fmtAmtU(sum(gone, 'btc'))})? Deposits you typed in yourself are kept.`)) {
        const ids = new Set(gone.map(d => d.id));
        data.deposits = data.deposits.filter(d => !ids.has(d.id));
        save(); render(); toast(`${plural(gone.length, 'deposit')} removed. Add them again from the lists above.`);
      }
    }
    else if (act === 'del-deposit' && confirm('Delete this deposit?')) { data.deposits = data.deposits.filter(d => d.id !== id); save(); render(); }
    else if (act === 'del-sale' && confirm('Delete this sale?')) { data.sales = data.sales.filter(s => s.id !== id); save(); render(); }
    else if (act === 'del-check' && confirm('Delete this balance check?')) { data.balanceChecks = data.balanceChecks.filter(d => d.id !== id); save(); render(); }
    else if (act === 'del-cycle') {
      const deps = data.deposits.filter(d => d.cycleId === id).length;
      if (confirm(`Delete this cycle${deps ? ` and its ${plural(deps, 'deposit')}` : ''}? Imported report data is kept.`)) {
        data.cycles = data.cycles.filter(c => c.id !== id);
        data.deposits = data.deposits.filter(d => d.cycleId !== id);
        save(); render();
      }
    }
  });

  document.addEventListener('change', async e => {
    const pf = e.target.closest('form[data-form="projection"]');
    if (pf) { pf.requestSubmit(); return; }
    if (e.target.id === 'backupInput' && e.target.files[0]) {
      try {
        const restored = migrate(JSON.parse(await e.target.files[0].text()));
        if (confirm('Replace all current data with this backup?')) { data = restored; save(); render(); toast('Backup restored'); }
      } catch (err) { toast('Not a valid backup file: ' + err.message, true); }
      e.target.value = '';
      return;
    }
    if (e.target.dataset.act === 'group-daily') { groupDaily = e.target.checked; render(); return; }
    const row = e.target.closest('[data-cycle]');
    if (row) {
      const c = data.cycles.find(x => x.id === row.dataset.cycle);
      const f = e.target.name;
      if (f === 'start' && !isIso(e.target.value)) return;
      const isNum = /Threshold$|^block(Th|Price)$/.test(f);
      c[f] = isNum ? (e.target.value === '' || !(num(e.target.value) >= 0) ? null : num(e.target.value)) : e.target.value;
      if (f === 'blockTh' && c.blockTh != null && c.blockTh < MIN_BLOCK_TH) { c.blockTh = MIN_BLOCK_TH; toast(`The platform's smallest block is ${MIN_BLOCK_TH} TH/s.`, true); }
      if (f === 'blockPrice') c.blockPriceDate = c.blockPrice > 0 ? todayIso() : null;
      save(); render(); toast(`${c.name}: saved`);
    }
  });

  document.addEventListener('submit', e => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (form.dataset.form === 'projection') {
      // Only fields the user changed stop following the current figures.
      const changed = n => form.elements[n].value !== form.elements[n].defaultValue;
      if (changed('capital')) proj.capital = num(f.capital) > 0 ? num(f.capital) : null;
      if (changed('per30')) proj.per30 = isFinite(num(f.per30)) ? num(f.per30) / 100 : null;
      if (changed('blockTh')) proj.blockTh = num(f.blockTh) > 0 ? Math.max(MIN_BLOCK_TH, Math.round(num(f.blockTh))) : null;
      if (changed('blockPrice')) proj.blockPrice = num(f.blockPrice) > 0 ? num(f.blockPrice) : null;
      if (changed('payoutAt')) proj.payoutAt = f.payoutAt === '' ? null : Math.max(0, num(f.payoutAt) || 0);
      proj.days = parseInt(f.days, 10) || 365;
      render();
      return;
    }
    if (form.dataset.form === 'cycle-settings') return; // fields save as they change
    if (form.dataset.form === 'deposit') {
      const rec = { id: uid(), cycleId: f.cycleId, date: f.date, btc: num(f.btc), usd: num(f.usd) > 0 ? num(f.usd) : null, kind: f.kind, note: f.note.trim() };
      if (num(f.btc) > 0) data.deposits.push(rec);
      else if (rec.usd) {
        usdToBtc(rec.usd, rec.date).then(r => {
          if (!r) { toast(`No BTC price found for ${fmtDate(rec.date)} (this needs an internet connection). Type the BTC amount instead.`, true); return; }
          rec.btc = r.btc;
          rec.note = [rec.note, `BTC worked out from ${fmtMoney(rec.usd)} at ${r.src}`].filter(Boolean).join(' · ');
          data.deposits.push(rec); save(); render(); toast(`Added: ${fmtAmtU(r.btc)}`);
        });
        return;
      } else { toast('Type a BTC amount, or a USD amount for the app to convert.', true); return; }
    } else if (form.dataset.form === 'deposit-suggested') {
      const picked = new Set([...form.querySelectorAll('input[name="day"]:checked')].map(i => i.value));
      const ss = suggestedDeposits().filter(s => picked.has(s.date));
      if (!ss.length) { toast('Tick the days to add first.', true); return; }
      const first = cyclesSorted()[0]?.id;
      let split = 0;
      // Added day by day, so each "sent back" can only use payouts not already used by an earlier one.
      for (const s of ss) {
        const what = `needed for ${[...s.orders.map(n => '#' + n), ...s.partial.map(n => 'part of #' + n)].join(', ')}`;
        const base = { cycleId: cycleIdForDate(s.date) || first, date: s.date, orders: s.orders };
        const backBtc = form.elements[`as-${s.date}`]?.value === 'recycled' ? Math.max(0, Math.min(s.btc, walletAvail(s.date))) : 0;
        if (backBtc > 0) {
          const whole = backBtc >= s.btc - 1e-8;
          data.deposits.push({ id: uid(), ...base, btc: +backBtc.toFixed(8), usd: whole ? s.usd : null, kind: 'recycled', note: `From the reports: withdrawn BTC sent back, ${what}` });
          if (!whole) split++;
        }
        const rest = +(s.btc - backBtc).toFixed(8);
        if (rest > 1e-8) data.deposits.push({ id: uid(), ...base, btc: rest, usd: backBtc > 0 ? null : s.usd, kind: 'new', note: `From the reports: new money, ${what}` });
      }
      toast(`${plural(ss.length, 'day')} added${split ? `. ${plural(split, 'day')} needed more than your payouts had brought to your wallet, so the rest was added as new money.` : ''}`);
    } else if (form.dataset.form === 'deposit-admin') {
      const nums = [...form.querySelectorAll('input[name="order"]:checked')].map(i => +i.value);
      const ps = data.purchases.filter(p => nums.includes(p.num));
      if (!ps.length) { toast('Tick the contracts you paid for first.', true); return; }
      const usd = sum(ps, p => (p.paidUsd > 0 ? p.paidUsd : 0));
      data.deposits.push({
        id: uid(), cycleId: f.cycleId, date: ps.map(p => p.date).sort()[0], btc: +sum(ps, contractValue).toFixed(8),
        usd: ps.every(p => p.paidUsd > 0) ? +usd.toFixed(2) : null, kind: f.kind === 'recycled' ? 'recycled' : 'new', outside: true, orders: nums,
        note: `Paid outside the platform for contract${nums.length > 1 ? 's' : ''} #${nums.join(', #')} (added by the admin)${f.kind === 'recycled' ? ', with BTC withdrawn earlier' : ''}`,
      });
    } else if (form.dataset.form === 'deposit-orders') {
      const nums = [...form.querySelectorAll('input[name="order"]:checked')].map(i => +i.value);
      const ps = data.purchases.filter(p => nums.includes(p.num));
      if (!ps.length) { toast('Tick the orders you paid in USDT first.', true); return; }
      data.deposits.push({
        id: uid(), cycleId: f.cycleId, date: ps.map(p => p.date).sort()[0],
        btc: +sum(ps, 'allocBtc').toFixed(8), usd: +sum(ps, 'allocUsd').toFixed(2), kind: 'new', orders: nums,
        note: `Paid in USDT for order${nums.length > 1 ? 's' : ''} #${nums.join(', #')}`,
      });
    } else if (form.dataset.form === 'sale') {
      if (!(num(f.btc) > 0) || !(num(f.usd) > 0)) { toast('Type the BTC sold and the USDT received.', true); return; }
      data.sales.push({ id: uid(), date: f.date, btc: num(f.btc), usd: num(f.usd), note: f.note.trim() });
      toast(`Sale added: ${fmtAmtU(num(f.btc))} for ${fmtMoney(num(f.usd))}`);
    } else if (form.dataset.form === 'check') {
      data.balanceChecks.push({ id: uid(), date: f.date, btc: num(f.btc), note: f.note.trim() });
    } else if (form.dataset.form === 'cycle') {
      if (data.cycles.some(c => c.start === f.start)) { toast('A cycle already starts on that date.', true); return; }
      const id = uid();
      data.cycles.push({ id, name: f.name.trim(), start: f.start, withdrawThreshold: null, notes: '' });
      if (num(f.carry) > 0) data.deposits.push({ id: uid(), cycleId: id, date: f.start, btc: num(f.carry), kind: 'carry', note: 'Balance carried over' });
      if (num(f.fresh) > 0) data.deposits.push({ id: uid(), cycleId: id, date: f.start, btc: num(f.fresh), usd: num(f.freshUsd) > 0 ? num(f.freshUsd) : null, kind: 'new', note: 'New BTC sent in' });
      currentScope = id;
      currentTab = 'overview';
      toast(`${f.name.trim()} started`);
    }
    save(); render();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (prefs.theme === 'auto') render(); });
}

async function init() {
  applyTheme();
  try { const s = localStorage.getItem(STORAGE_KEY); if (s) data = migrate(JSON.parse(s)); } catch { /* ignore */ }
  if (!('showDirectoryPicker' in window)) fileState = 'unsupported';
  else {
    try { dirHandle = (await IDB.get('dirHandle')) || null; } catch { dirHandle = null; }
    if (dirHandle) {
      try {
        if ((await dirHandle.queryPermission({ mode: 'readwrite' })) === 'granted') await loadFromFolder();
        else fileState = 'reconnect';
      } catch { fileState = 'reconnect'; }
    }
  }
  bind();
  render();
  fetchPrice();
  setInterval(fetchPrice, 60_000);
  if (location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}


// ---------- help popups for the "?" marks (hover, keyboard focus, or tap) ----------
const tipEl = Object.assign(document.createElement('div'), { className: 'tip-pop', role: 'tooltip' });
let tipFor = null;
function showTip(el) {
  if (!el.dataset.tip) return;
  tipFor = el;
  tipEl.textContent = el.dataset.tip;
  if (!tipEl.isConnected) document.body.append(tipEl);
  tipEl.style.display = 'block';
  const r = el.getBoundingClientRect(), w = tipEl.offsetWidth, h = tipEl.offsetHeight, pad = 8;
  let left = Math.min(Math.max(pad, r.left + r.width / 2 - w / 2), innerWidth - w - pad);
  let top = r.top - h - 8;
  if (top < pad) top = r.bottom + 8;
  tipEl.style.left = `${left}px`;
  tipEl.style.top = `${top}px`;
}
function hideTip() { tipFor = null; tipEl.style.display = 'none'; }
document.addEventListener('mouseover', e => { const h = e.target.closest?.('.help'); if (h && h !== tipFor) showTip(h); });
document.addEventListener('mouseout', e => { const h = e.target.closest?.('.help'); if (h && !h.contains(e.relatedTarget) && document.activeElement !== h) hideTip(); });
document.addEventListener('focusin', e => { if (e.target.classList?.contains('help')) showTip(e.target); });
document.addEventListener('focusout', e => { if (e.target.classList?.contains('help')) hideTip(); });
document.addEventListener('click', e => {
  const h = e.target.closest?.('.help');
  if (h) { e.preventDefault(); e.stopPropagation(); tipFor === h && tipEl.style.display === 'block' && e.pointerType !== 'mouse' ? hideTip() : showTip(h); }
  else if (tipFor) hideTip();
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
addEventListener('scroll', hideTip, true);
addEventListener('resize', hideTip);

// Exposed for testing and for loading data from the console.
window.cloudMining = { importCsv, compute, warnings, simulate, get data() { return data; }, set data(v) { data = migrate(v); render(); }, save, render };

init();
