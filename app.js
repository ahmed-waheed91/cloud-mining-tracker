'use strict';

// Cloud Mining Tracker — all amounts are BTC; USD/AED is display-only at the live price.
// Data lives in a folder the user picks (File System Access API, Chrome): cloud-mining.json
// plus daily backups. It is mirrored to localStorage so nothing is lost while disconnected.

const APP_VERSION = '1.6.0';
const DATA_VERSION = 2;
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
    deposits: [],      // {id, cycleId, date, btc, kind: 'new'|'carry', note}
    balanceChecks: [], // {id, date, btc, note}
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

// Purchases: each order # appears as a "purchased" line (what you paid) and an
// "allocated" line (what went into the contract). Merge into one record per #.
function importPurchases(body, file) {
  const groups = new Map();
  for (const r of body) {
    const n = parseInt(r['#'], 10);
    if (!n) continue;
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(r);
  }
  let added = 0, updated = 0;
  for (const [n, rs] of groups) {
    const bought = rs.find(r => /purchas/i.test(r['Type']));
    const alloc = rs.find(r => /alloc/i.test(r['Type']));
    const any = bought || alloc;
    const prev = data.purchases.find(p => p.num === n);
    const rec = {
      num: n,
      date: any['Purchased'], start: any['Start'], end: any['End'],
      th: num(any['TH/s']), days: num(any['Days']) || CONTRACT_DAYS,
      paidBtc: bought ? num(bought['Paid BTC']) : prev?.paidBtc ?? num(alloc['Paid BTC']),
      allocBtc: alloc ? num(alloc['Paid BTC']) : prev?.allocBtc ?? num(bought['Paid BTC']),
      paidUsd: bought ? num(bought['Paid USD']) : prev?.paidUsd ?? NaN,
      // USD at the moment of purchase: the USDT paid, or the BTC at that time's price
      allocUsd: alloc ? num(alloc['Paid USD']) : prev?.allocUsd ?? null,
      contractId: alloc ? alloc['Contract'] : prev?.contractId ?? '',
      status: (alloc || bought)['Status'],
    };
    if (prev) { Object.assign(prev, rec); updated++; } else { data.purchases.push(rec); added++; }
  }
  data.purchases.sort((a, b) => a.num - b.num);
  return { file, ok: true, msg: `Purchases: ${added} new contracts, ${updated} refreshed.` };
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
  for (const d of days) d.ret = d.cost > 0 ? d.profit / (d.cost * CONTRACT_DAYS) : NaN;

  const m = {};
  m.in = sum(D, 'btc');
  m.carriedOut = sum(carryOut, 'btc');
  // A contract's real cost is its allocated BTC. The report's "purchased" BTC on USDT-paid orders is
  // the USD converted at one report-wide rate, not what left the balance (checked against the dashboard).
  m.paid = sum(P, 'allocBtc');
  m.alloc = m.paid;
  m.received = sum(days, 'total');
  m.capBack = sum(days, 'cost');
  m.profit = sum(days, 'profit');
  m.bonus = sum(days, 'bonus');
  m.mining = m.profit - m.bonus;
  m.withdrawn = sum(W, 'btc');
  m.balance = m.in - m.paid + m.received - m.withdrawn - m.carriedOut;
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
  m.working = sum(active, 'allocBtc');

  m.recovered = m.withdrawn + m.carriedOut;
  m.remaining = m.in - m.recovered;
  m.rate = m.windows.d30.profitPerDay;
  m.daysToRecover = m.remaining > 0 && m.rate > 0 ? Math.ceil(m.remaining / m.rate) : null;

  return { m, days, P, W, D, E, cycle, scope };
}

function winStats(ds) {
  const cost = sum(ds, 'cost'), profit = sum(ds, 'profit');
  return {
    n: ds.length, profit, cost,
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
  const deps = (scope === 'all' ? data.deposits.filter(d => d.kind !== 'carry') : data.deposits.filter(d => d.cycleId === scope)).filter(d => le(d.date));
  const nc = scope === 'all' ? null : nextCycle(scope);
  const carry = nc ? data.deposits.filter(d => d.cycleId === nc.id && d.kind === 'carry' && le(d.date)) : [];
  const paid = sum(data.purchases.filter(p => inS(p.date) && le(p.date)), 'allocBtc');
  const recv = sum(data.earnings.filter(r => inS(r.date) && le(r.date)), 'totalBtc');
  const out = sum(data.payouts.filter(p => inS(p.requested) && le(p.requested) && !isFailed(p.status)), 'btc');
  return sum(deps, 'btc') - paid + recv - out - sum(carry, 'btc');
}

function contractRows(P) {
  const today = todayIso();
  return P.map(p => {
    const s = data.summaries.find(x => x.contractId && x.contractId === p.contractId);
    const daysLeft = daysBetween(today, p.end);
    return {
      ...p, s,
      satsPerTh: (p.allocBtc / p.th) * 1e8,
      state: today < p.start ? 'not started' : today > p.end ? 'ended' : `active · ${daysLeft + 1}d left`,
      active: today >= p.start && today <= p.end,
      shortfall: s ? s.costBtc - s.capitalBackBtc : NaN,
    };
  });
}

function monthRows(R) {
  const months = new Map();
  const get = ym => {
    if (!months.has(ym)) months.set(ym, { ym, days: 0, total: 0, cost: 0, profit: 0, bonus: 0, lossDays: 0, withdrawn: 0, bought: 0, boughtBtc: 0 });
    return months.get(ym);
  };
  for (const d of R.days) {
    const r = get(d.date.slice(0, 7));
    r.days++; r.total += d.total; r.cost += d.cost; r.profit += d.profit; r.bonus += d.bonus;
    if (d.profit < 0) r.lossDays++;
  }
  for (const w of R.W) get(w.requested.slice(0, 7)).withdrawn += w.btc;
  for (const p of R.P) { const r = get(p.date.slice(0, 7)); r.bought++; r.boughtBtc += p.allocBtc; }
  return [...months.values()].sort((a, b) => (a.ym < b.ym ? -1 : 1)).map(r => ({ ...r, per30: r.cost > 0 ? r.profit / r.cost : NaN }));
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
  else if (m.capBack > m.alloc + 1e-7) add('warn', 'More capital has come back than was put into contracts — a <b>hashrate purchases</b> report may be missing.');

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

  for (const p of R.W.filter(p => !isDone(p.status))) add('info', `Payout of ${fmtAmtU(p.btc)} requested on ${fmtDate(p.requested)} is still "${esc(p.status)}".`);

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
  if (currentTab === 'overview') drawOverviewCharts(R);
  if (currentTab === 'contracts') drawContractChart(R);
  if (currentTab === 'projection') drawProjection(R);
  main.querySelectorAll('table[data-sort-id]').forEach(applySort);
}

function renderTopbar() {
  const sel = $('#scope');
  const cs = cyclesSorted();
  sel.innerHTML = cs.map(c => `<option value="${c.id}">${esc(c.name)} (from ${fmtDate(c.start)})</option>`).join('')
    + `<option value="all">All time</option>`;
  sel.value = currentScope;
  const p = usdPrice();
  $('#price').innerHTML = p
    ? `BTC <b>${fmtMoney(p)}</b> <span title="${btcUsd ? 'Live price' : 'No live price — using the BTC/USD from the latest daily report'}">${btcUsd ? '· live' : '· last report'}</span>`
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
        <div class="big ${tone(m.in ? m.net : m.profit)}">${fmtAmt(m.in ? m.net : m.profit, true)} <small>${unitLabel()}</small></div>
        <div class="usd">${fiat(m.in ? m.net : m.profit) ? '≈ ' + fiat(m.in ? m.net : m.profit) : ''}${m.in ? ` · ${fmtPct(m.retOnIn, 2, true)} of money in` : ''}</div>
      </div>
      ${m.in ? `<div class="back">
        <div class="label">Money back in your wallet</div>
        <div class="back-pct">${fmtPct(pct, 1)}</div>
        <div class="progress"><div style="width:${(pct * 100).toFixed(1)}%"></div></div>
        <div class="hint">${fmtAmtU(m.recovered)} of ${fmtAmtU(m.in)}${m.carriedOut ? ' (incl. carried over)' : ''}. ${backText}</div>
      </div>` : ''}
    </div>
    <div class="hero-stats">
      ${m.in ? mini('Money in', m.in, 'BTC you sent to the platform for this cycle (including any balance carried over from the previous cycle).')
        : `<div class="mini"><div class="label">Money in</div><div class="v warn">none yet</div><div class="usd">Add it on the Money in &amp; out tab.</div></div>`}
      ${mini('Withdrawn to your wallet', m.withdrawn, 'Payouts sent to your own wallet.', m.carriedOut ? `+ ${fmtAmt(m.carriedOut)} carried on` : plural(R.W.length, 'payout'))}
      ${mini('Still on the platform', m.onPlatform, `Your BTC that is still exposed to the platform: ${fmtAmtU(m.balance)} available balance plus ${fmtAmtU(m.outstanding)} of capital inside contracts that has not come back yet.`)}
    </div>
  </section>`;
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
  </section>`;
}

// Warnings that need action stay as they are; info notes and the last-import summary shrink to one line each.
function renderNotices(R) {
  const ws = warnings(R);
  const warn = ws.filter(w => w.level === 'warn');
  const info = prefs.notesHidden === todayIso() ? [] : ws.filter(w => w.level !== 'warn');
  const out = [];
  if (warn.length) out.push(`<div class="warnings">${warn.map(w => `<div class="alert warn">⚠ <span>${w.text}</span></div>`).join('')}</div>`);
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
  const yAxis = (extra = {}) => ({ ticks: { color: muted }, grid: { color: grid }, ...extra });
  return { v, base, yAxis };
}
const dayLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function drawOverviewCharts(R) {
  const el = $("#chOverview");
  if (typeof Chart === "undefined" || !R.days.length || !el) return;
  const which = OV_CHARTS[prefs.ovChart] ? prefs.ovChart : "daily";
  const { v, base, yAxis } = chartTheme();
  const k = unitScale();
  const days = R.days;
  if (which === 'daily') charts.daily = new Chart(el, {
    data: {
      labels: days.map(d => dayLabel(d.date)),
      datasets: [
        { type: 'bar', label: `Profit ${unitLabel()}`, data: days.map(d => d.profit * k), backgroundColor: days.map(d => (d.profit < 0 ? v('--neg') : v('--chart-1'))), yAxisID: 'y' },
        { type: 'line', label: 'Return/day %', data: days.map(d => d.ret * 100), borderColor: v('--chart-2'), pointRadius: 0, borderWidth: 2, yAxisID: 'y1' },
      ],
    },
    options: { ...base, scales: { ...base.scales, y: yAxis(), y1: yAxis({ position: 'right', grid: { drawOnChartArea: false } }) } },
  });

  const first = days[0].date, last = days.at(-1).date;
  const span = [];
  for (let d = first; d <= last; d = addDays(d, 1)) span.push(d);
  if (which === 'capital') charts.capital = new Chart(el, {
    type: 'line',
    data: {
      labels: span.map(dayLabel),
      datasets: [{ label: 'Capital working', data: span.map(d => sum(R.P.filter(p => p.start <= d && d <= p.end), 'allocBtc') * k), borderColor: v('--chart-1'), backgroundColor: v('--chart-1') + '33', fill: true, pointRadius: 0, stepped: true }],
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
  const { v, base, yAxis } = chartTheme();
  const rows = contractRows(R.P);
  const prices = rows.map(r => r.satsPerTh).filter(isFinite);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const pad = Math.max((hi - lo) * 0.5, hi * 0.01);
  charts.price = new Chart(el, {
    data: {
      labels: rows.map(r => `#${r.num} · ${dayLabel(r.date)}`),
      datasets: [
        { type: 'bar', label: 'Price (sats per TH, 30 days)', data: rows.map(r => r.satsPerTh), backgroundColor: v('--chart-1'), yAxisID: 'y' },
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
  const price = dayPrices[p.date];
  return price > 0 ? { usd: p.allocBtc * price, est: true } : { usd: NaN, est: false };
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
    th: sum(rows, 'th'), cost: sum(rows, 'allocBtc'), usd: sum(rows, r => contractUsd(r).usd || 0),
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
      ${td(r.num, r.num, '')}${td(r.date, fmtDate(r.date), '')}${td(r.end, fmtDate(r.end), '')}${td(r.active ? 0 : 1, esc(r.state), '')}
      ${td(r.th, r.th.toLocaleString('en-US'))}${td(r.allocBtc, fmtAmt(r.allocBtc))}${usdCell(r)}
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

  return `
  <h2>Monthly summary</h2>
  <p class="hint">Calendar months. Return per 30 days = profit ÷ capital back in that month.</p>
  <div class="table-wrap"><table data-sort-id="months">
    <thead><tr><th>Month</th><th class="n">Days</th><th class="n">Received (${u})</th><th class="n">Profit (${u})</th><th class="n">Profit ${cur} (now)</th><th class="n">Return / 30 days</th><th class="n">Loss days</th><th class="n">Withdrawn (${u})</th><th class="n">Contracts bought</th></tr></thead>
    <tbody>${[...months].reverse().map(mo => `<tr>
      ${td(mo.ym, fmtMonth(mo.ym), '')}${td(mo.days, mo.days)}${td(mo.total, fmtAmt(mo.total))}
      ${td(mo.profit, fmtAmt(mo.profit, true), 'n ' + tone(mo.profit))}${td(mo.profit, fiat(mo.profit) || '—')}
      ${td(mo.per30, fmtPct(mo.per30, 2, true), 'n ' + tone(mo.per30))}${td(mo.lossDays, mo.lossDays || '—', 'n ' + (mo.lossDays ? 'neg' : ''))}
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
  let contracts = R.P.filter(p => p.end > start).map(p => ({ btc: p.allocBtc, left: Math.min(CONTRACT_DAYS, daysBetween(start, p.end)) }));
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
  const orderChoices = R.P.filter(p => p.allocUsd > 0 && !usedOrders.has(p.num));
  const needReimport = R.P.some(p => !(p.allocUsd > 0));

  return `${renderFiatResult(R)}
  <div class="cols"><div>
  <h2>Deposits (money in)</h2>
  <p class="hint">Add every amount you send to the platform — the reports don't show deposits. When a new cycle starts with the leftover balance, add that as "Carried over". If you paid in USDT, type the USD amount too; otherwise the app estimates it from that day's average BTC price (marked ~).</p>
  ${cs.length ? `<form class="inline" data-form="deposit">
    <label>Date<input type="date" name="date" value="${todayIso()}" required></label>
    <label>BTC<input type="number" name="btc" step="0.00000001" min="0" required style="width:150px"></label>
    <label>USD/USDT paid (optional)<input type="number" name="usd" step="0.01" min="0" style="width:130px"></label>
    <label>Type<select name="kind"><option value="new">New BTC sent in</option><option value="carry">Carried over from previous cycle</option></select></label>
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
  </details>` : `<div class="empty">Start a cycle first on the <b>Settings</b> tab.</div>`}
  ${deposits.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Cycle</th><th>Type</th><th class="n">${u}</th><th class="n">${cur} then</th><th class="n">${cur} now</th><th class="n">Change ${help('How much the value of that BTC has moved since, from the BTC price alone.')}</th><th>Note</th><th></th></tr></thead>
    <tbody>${deposits.map((d, i) => editing?.type === 'deposit' && editing.id === d.id
      ? `<tr data-edit="deposit" data-id="${d.id}"><td><input type="date" name="date" value="${d.date}"></td>
        <td>${cycleSelect(d.cycleId)}</td>
        <td><select name="kind"><option value="new" ${d.kind !== 'carry' ? 'selected' : ''}>New BTC</option><option value="carry" ${d.kind === 'carry' ? 'selected' : ''}>Carried over</option></select></td>
        <td class="n"><input type="number" name="btc" step="0.00000001" min="0" value="${d.btc}" style="width:140px" title="BTC"></td>
        <td class="n"><input type="number" name="usd" step="0.01" min="0" value="${d.usd > 0 ? d.usd : ''}" style="width:110px" title="USD/USDT paid — leave empty to estimate" placeholder="estimate"></td><td></td><td></td>
        <td><input name="note" value="${esc(d.note)}" style="width:100%;min-width:200px"></td>
        <td class="actions"><button class="primary" data-act="save-edit">Save</button><button data-act="cancel-edit">Cancel</button></td></tr>`
      : `<tr><td>${fmtDate(d.date)}</td><td>${cycleName(d.cycleId)}</td><td>${d.kind === 'carry' ? 'Carried over' : 'New BTC'}</td>
        <td class="n">${fmtAmt(d.btc)}</td>${valueCells(depVals[i], d.btc, estDay)}<td class="note">${esc(d.note)}</td>
        <td class="actions"><button data-act="edit" data-type="deposit" data-id="${d.id}">Edit</button><button class="danger" data-act="del-deposit" data-id="${d.id}">Delete</button></td></tr>`).join('')}
    ${deposits.length > 1 ? `<tr class="total"><td colspan="3">Total (${deposits.length})</td><td class="n">${fmtAmt(sum(deposits, 'btc'))}</td>${valueCells(sumUsd(depVals), sum(deposits, 'btc'), 'Includes estimates.')}<td></td><td></td></tr>` : ''}</tbody>
  </table></div>` : ''}
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

// The result in USD/AED: money in and out valued on the day they moved, what is left at today's price.
function renderFiatResult(R) {
  const { m } = R;
  const price = usdPrice();
  if (!R.D.length || !price) return '';
  const nc = R.scope === 'all' ? null : nextCycle(R.scope);
  const carry = nc ? data.deposits.filter(d => d.cycleId === nc.id && d.kind === 'carry') : [];
  const inV = sumUsd(R.D.map(depositUsd));
  const outV = sumUsd([...R.W.map(payoutUsd), ...carry.map(depositUsd)]);
  const left = m.onPlatform * price;
  const result = outV.usd + left - inV.usd;
  const est = inV.est || outV.est;
  // ~ marks a figure that includes estimates
  const t = (v, e = est) => (isFinite(v) ? (e ? '~' : '') + fmtMoney(v) : '—');
  const sign = (v, e = est) => (isFinite(v) && v > 0.005 ? (e ? '~+' : '+') + fmtMoney(v) : t(v, e));
  const mining = m.net * price;
  return `<h2>Your result in ${prefs.currency}</h2>
  <div class="grid">
    ${card('Money in', 0, { text: t(inV.usd, inV.est), help: 'Your deposits, valued on the day you sent them: the USD/USDT you paid, else that day\'s average BTC price.', sub: fmtAmtU(m.in) })}
    ${card('Withdrawn', 0, { text: t(outV.usd, outV.est), help: 'Payouts valued on the day they reached your wallet' + (carry.length ? ', plus the balance carried to the next cycle on that day' : '') + '.', sub: fmtAmtU(m.withdrawn + m.carriedOut) })}
    ${card('Still on the platform', 0, { text: fmtMoney(left), help: 'Your balance and the capital still in contracts, at today\'s BTC price.', sub: fmtAmtU(m.onPlatform) })}
    ${card('Result', 0, { text: sign(result), tone: tone(result), help: 'Withdrawn + still on the platform − money in, all in ' + prefs.currency + '.', sub: isFinite(result) && inV.usd > 0 ? `${fmtPct(result / inV.usd, 2, true)} of money in` : '' })}
  </div>
  ${isFinite(result) ? `<p class="hint" style="margin-top:8px">Of which <b>from mining</b>: ${sign(mining, false)} (your net ${fmtAmtU(m.net, true)} at today's price) · <b>from the BTC price moving</b>: ${sign(result - mining)}.${est ? ' ~ = includes estimates from daily average prices.' : ''}</p>` : '<p class="hint" style="margin-top:8px">Waiting for the BTC prices of those days (this needs an internet connection).</p>'}`;
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
    <div style="margin-bottom:8px"><b>${esc(c.name)}</b>: auto-reinvest and payout ${help('Copy what you set on the platform. The app uses these for its calculations and the Projection tab; it never changes anything on the platform.')}</div>
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
    if (['contracts', 'money'].includes(currentTab) && !document.activeElement?.closest('form, tr[data-edit]')) render();
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
      if (!isIso(v.date) || !(num(v.btc) >= 0)) { toast('Enter a valid date and BTC amount.', true); return; }
      const list = tr.dataset.edit === 'deposit' ? data.deposits : data.balanceChecks;
      const rec = list.find(x => x.id === tr.dataset.id);
      Object.assign(rec, { date: v.date, btc: num(v.btc), note: v.note.trim() });
      if (v.kind) rec.kind = v.kind;
      if (v.cycleId) rec.cycleId = v.cycleId;
      if ('usd' in v) rec.usd = num(v.usd) > 0 ? num(v.usd) : null;
      editing = null; save(); render(); toast('Saved');
    }
    else if (act === 'del-deposit' && confirm('Delete this deposit?')) { data.deposits = data.deposits.filter(d => d.id !== id); save(); render(); }
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
      data.deposits.push({ id: uid(), cycleId: f.cycleId, date: f.date, btc: num(f.btc), usd: num(f.usd) > 0 ? num(f.usd) : null, kind: f.kind, note: f.note.trim() });
    } else if (form.dataset.form === 'deposit-orders') {
      const nums = [...form.querySelectorAll('input[name="order"]:checked')].map(i => +i.value);
      const ps = data.purchases.filter(p => nums.includes(p.num));
      if (!ps.length) { toast('Tick the orders you paid in USDT first.', true); return; }
      data.deposits.push({
        id: uid(), cycleId: f.cycleId, date: ps.map(p => p.date).sort()[0],
        btc: +sum(ps, 'allocBtc').toFixed(8), usd: +sum(ps, 'allocUsd').toFixed(2), kind: 'new', orders: nums,
        note: `Paid in USDT for order${nums.length > 1 ? 's' : ''} #${nums.join(', #')}`,
      });
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
