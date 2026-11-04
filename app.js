'use strict';

// Cloud Mining Tracker — all amounts are BTC; USD/AED is display-only at the live price.
// Data lives in a folder the user picks (File System Access API, Chrome): cloud-mining.json
// plus daily backups. It is mirrored to localStorage so nothing is lost while disconnected.

const APP_VERSION = '1.3.0';
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
const proj = { capital: null, per30: null, days: 365, custom: 75 };
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
    cycles: [],        // {id, name, start, reinvestThreshold, withdrawThreshold, notes}
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

  for (const p of R.W.filter(p => !isDone(p.status))) add('info', `Payout of ${fmtAmtU(p.btc)} requested on ${fmtDate(p.requested)} is still "${esc(p.status)}".`);

  return out;
}

// Simple forward model: capital earns `rate` per day; a share of each day's profit is reinvested.
function project(capital, rate, days, share) {
  let C = capital, W = 0;
  const cap = [C], wd = [0];
  for (let i = 1; i <= days; i++) {
    const p = C * rate;
    W += p * (1 - share);
    C += p * share;
    cap.push(C); wd.push(W);
  }
  return { cap, wd };
}

// ---------- rendering ----------
function help(text) { return `<span class="help" title="${esc(text)}">?</span>`; }
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
  } else {
    b.innerHTML = `Not connected to a data folder — changes are only kept in this browser.
      <button class="primary" data-act="open-folder">Choose data folder</button>`;
  }
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

function renderHeadline(m) {
  if (!m.in && !m.profit) return '';
  const parts = [];
  if (m.in) {
    parts.push(`You've put in <b>${fmtAmtU(m.in)}</b>, taken <b>${fmtAmtU(m.withdrawn)}</b> back to your wallet${m.carriedOut ? ` and carried <b>${fmtAmtU(m.carriedOut)}</b> to the next cycle` : ''}, and <b>${fmtAmtU(m.onPlatform)}</b> is still on the platform.`);
    parts.push(`Overall you're <b class="${tone(m.net)}">${m.net >= 0 ? 'up' : 'down'} ${fmtAmtU(Math.abs(m.net))} (${fmtPct(m.retOnIn, 1, true)})</b>${fiat(m.net) ? ` ≈ ${fiat(Math.abs(m.net))}` : ''}.`);
  } else {
    parts.push(`Profit so far: <b class="${tone(m.profit)}">${fmtAmtU(m.profit, true)}</b>.`);
  }
  const w = m.windows.d30;
  if (isFinite(w.per30)) parts.push(`Profit is running at <b>${fmtPct(w.per30, 2)} per 30 days</b> on the capital working (last ${plural(w.n, 'day')}).`);
  return `<p class="headline">${parts.join(' ')}</p>`;
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
  return `<div class="panel import-panel">
    <div class="panel-head"><b>Last import</b> <span class="hint" style="margin:0">${new Date(li.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · view: ${esc(li.scopeName)}</span>
      <button class="link" data-act="dismiss-import">Dismiss</button></div>
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
  </div>`;
}
function fmtPctPlain(v) { return fmtPct(v, 2); }

function renderWarnings(R) {
  const ws = warnings(R);
  if (!ws.length) return '';
  return `<div class="warnings">${ws.map(w => `<div class="alert ${w.level}">${w.level === 'warn' ? '⚠' : 'ℹ'} <span>${w.text}</span></div>`).join('')}</div>`;
}

function renderOverview(R) {
  const { m, days } = R;
  const isNew = !data.cycles.length && !data.earnings.length && !data.purchases.length;
  if (isNew) return renderWelcome();
  if (!days.length && !m.in) {
    return `${renderWarnings(R)}<div class="empty">No data in this view yet.<br><br>
      Click <b>Import reports</b> (or drag the CSV files onto this page), and add your deposit on the <b>Money in &amp; out</b> tab.</div>`;
  }
  const w = m.windows;
  const retRow = (label, key, dp, helpText) => `<tr><td>${label} ${help(helpText)}</td>
    ${['d7', 'd30', 'all'].map(k => `<td class="n ${tone(w[k][key])}">${fmtPct(w[k][key], dp, true)}</td>`).join('')}</tr>`;
  const recoveredPct = m.in > 0 ? Math.min(1, Math.max(0, m.recovered / m.in)) : 0;
  const checks = data.balanceChecks.filter(c => currentScope === 'all' || cycleIdForDate(c.date) === currentScope).sort(byDate);
  const lastCheck = checks.at(-1);
  const checkDiff = lastCheck ? lastCheck.btc - balanceAt(currentScope, lastCheck.date) : NaN;
  const cyc = R.cycle;
  const u = unitLabel();

  return `
  ${renderHeadline(m)}
  <div class="cols top-panels">${renderImportPanel() ? `<div>${renderImportPanel()}</div>` : ''}${renderWarnings(R) ? `<div>${renderWarnings(R)}</div>` : ''}</div>

  <h2>Where your money is</h2>
  <div class="grid">
    ${card('Money in', m.in, { help: 'BTC you sent to the platform for this cycle (including any balance carried over from the previous cycle).', sub: m.in ? '' : '<span class="warn">No deposit recorded — add it on the Money in &amp; out tab.</span>' })}
    ${card('Withdrawn to your wallet', m.withdrawn, { help: 'Payouts sent to your own wallet.' + (m.carriedOut ? ' Carried over to the next cycle is shown below.' : ''), sub: m.carriedOut ? `+ ${fmtAmtU(m.carriedOut)} carried to next cycle` : plural(R.W.length, 'payout') })}
    ${card('Still on the platform', m.onPlatform, { help: 'Your BTC that is still exposed to the platform: the available balance plus capital inside contracts that has not come back yet.', sub: `${fmtAmt(m.balance)} balance · ${fmtAmt(m.outstanding)} in contracts` })}
    ${card('Net result', m.net, { sign: true, tone: tone(m.net), help: 'Withdrawn + still on the platform − money in. This is your real profit or loss after loss days.', sub: `${fmtPct(m.retOnIn, 2, true)} of money in` })}
  </div>

  <div class="cols charts-right"><div class="left">
  <h2>Returns (in BTC)</h2>
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

  <h2>Getting your money back</h2>
  <div class="panel">
    <div>${fmtAmtU(m.recovered)} of ${fmtAmtU(m.in)} back in your wallet${m.carriedOut ? ' (incl. carried over)' : ''} — <b>${fmtPct(recoveredPct, 1)}</b></div>
    <div class="progress"><div style="width:${(recoveredPct * 100).toFixed(1)}%"></div></div>
    <div class="hint" style="margin:0">${m.remaining <= 0 ? 'All money in is back — everything from here is profit.'
      : m.daysToRecover ? `At the last 30 days' profit (${fmtAmtU(m.rate)}/day), the rest takes about <b>${m.daysToRecover} days</b> → around <b>${fmtDate(addDays(m.last || todayIso(), m.daysToRecover))}</b>. Assumes capital keeps being reinvested and profit is withdrawn. See <b>Projection</b> for other scenarios.`
      : 'Not enough profit history yet to project.'}</div>
  </div>

  <h2>Profit breakdown</h2>
  <div class="grid">
    ${card('Total profit', m.profit, { sign: true, tone: tone(m.profit), help: 'Σ Profit from the daily report (Total − Cost). Includes loss days.', sub: `on ${fmtAmt(m.capBack)} capital returned` })}
    ${card('From the bonus', m.bonus, { help: 'The platform adds a bonus on top of what the hashrate mines.', sub: m.profit ? `${fmtPct(m.bonus / m.profit, 0)} of total profit` : '' })}
    ${card('From mining itself', m.mining, { sign: true, tone: tone(m.mining), help: 'Profit without the bonus. Near zero means the mining only covers the contract price.' })}
    ${card('Loss days', m.lossBtc, { sign: true, tone: m.lossBtc < 0 ? 'neg' : '', help: 'Days where the payout was less than the capital due back. The shortfall is lost capital.', sub: plural(m.lossDays, 'day') })}  </div>

  <h2>Right now</h2>
  <div class="grid">
    ${card('Capital working', m.working, { help: 'Price of all contracts active today.', sub: `${plural(m.activeCount, 'active contract')} · ${m.activeTh.toLocaleString('en-US')} TH/s` })}
    ${card('Available balance (calculated)', m.balance, { help: 'Money in − paid for contracts + received − withdrawn. Returned capital and profit waiting for the reinvest/withdraw thresholds.', sub: cyc && (cyc.reinvestThreshold || cyc.withdrawThreshold) ? `Reinvest at ${fmtAmt(cyc.reinvestThreshold || NaN)} · withdraw at ${fmtAmt(cyc.withdrawThreshold || NaN)}` : '' })}
    ${lastCheck ? card('Balance check', checkDiff, { sign: true, tone: Math.abs(checkDiff) < 1e-6 ? 'pos' : 'warn', help: 'Your dashboard balance minus the calculated balance on that date. Small differences usually mean a payout that is not in the imported reports yet.', sub: `Dashboard ${fmtAmt(lastCheck.btc)} on ${fmtDate(lastCheck.date)}`, fiat: false }) : ''}
    ${card('Data up to', 0, { text: fmtDate(m.last), sub: plural(days.length, 'day') + ' of earnings' })}
  </div>
  </div><div class="right">

  <h2>Charts</h2>
  <div class="charts">
    <div class="chart-box"><h3>Daily profit (${u}) and return per day</h3><div class="canvas"><canvas id="chDaily"></canvas></div></div>
    <div class="chart-box"><h3>Capital working in contracts (${u})</h3><div class="canvas"><canvas id="chCapital"></canvas></div></div>
    <div class="chart-box"><h3>Running totals (${u})</h3><div class="canvas"><canvas id="chCumul"></canvas></div></div>
  </div>
  </div></div>`;
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
  if (typeof Chart === 'undefined' || !R.days.length) return;
  const { v, base, yAxis } = chartTheme();
  const k = unitScale();
  const days = R.days;
  charts.daily = new Chart($('#chDaily'), {
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
  charts.capital = new Chart($('#chCapital'), {
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
  charts.cumul = new Chart($('#chCumul'), {
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
function renderContracts(R) {
  const rows = contractRows(R.P).reverse();
  if (!rows.length) return `<div class="empty">No contracts in this view. Import the <b>hashrate purchases</b> report.</div>`;
  const hasS = rows.some(r => r.s);
  const u = unitLabel();
  const t = {
    th: sum(rows, 'th'), cost: sum(rows, 'allocBtc'),
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
    <thead><tr><th>#</th><th>Bought</th><th>Ends</th><th>Status</th><th class="n">TH/s</th><th class="n">Cost (${u})</th><th class="n">sats / TH</th>
      ${hasS ? `<th class="n">Earned (${u})</th><th class="n">Capital back (${u})</th><th class="n">Profit (${u})</th><th class="n">Margin</th><th class="n">Capital lost</th>` : ''}</tr></thead>
    <tbody>
    ${rows.map(r => `<tr>
      ${td(r.num, r.num, '')}${td(r.date, fmtDate(r.date), '')}${td(r.end, fmtDate(r.end), '')}${td(r.active ? 0 : 1, esc(r.state), '')}
      ${td(r.th, r.th.toLocaleString('en-US'))}${td(r.allocBtc, fmtAmt(r.allocBtc))}
      ${td(r.satsPerTh, r.satsPerTh.toFixed(0))}
      ${hasS ? (r.s ? `${td(r.s.earnedBtc, fmtAmt(r.s.earnedBtc))}${td(r.s.capitalBackBtc, fmtAmt(r.s.capitalBackBtc))}
        ${td(r.s.profitBtc, fmtAmt(r.s.profitBtc, true), 'n ' + tone(r.s.profitBtc))}${td(r.s.marginPct, isFinite(r.s.marginPct) ? r.s.marginPct.toFixed(2) + '%' : '—')}
        ${td(r.active ? 0 : -r.shortfall, r.active ? '<small>running</small>' : r.shortfall > 1e-8 ? fmtAmt(-r.shortfall, true) : '—', 'n ' + (!r.active && r.shortfall > 1e-8 ? 'neg' : ''))}`
        : '<td colspan="5" class="hint">no results imported</td>') : ''}
    </tr>`).join('')}
    <tr class="total"><td colspan="4">Total (${rows.length})</td><td class="n">${t.th.toLocaleString('en-US')}</td><td class="n">${fmtAmt(t.cost)}</td><td></td>
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

function renderProjection(R) {
  const { m } = R;
  const defCap = m.onPlatform > 0 ? m.onPlatform : m.in;
  const defPer30 = isFinite(m.windows.d30.per30) ? m.windows.d30.per30 : m.windows.all.per30;
  const capital = proj.capital ?? defCap;
  const per30 = proj.per30 ?? defPer30;
  if (!(capital > 0) || !isFinite(per30)) {
    return `<div class="empty">Not enough data to project yet. Import some daily earnings and record your deposit first.</div>`;
  }
  const rate = per30 / CONTRACT_DAYS;
  const shares = [...new Set([0, 0.25, 0.5, 1, proj.custom / 100])].sort((a, b) => a - b);
  const start = m.last || todayIso();
  const rows = shares.map(s => {
    const p = project(capital, rate, proj.days, s);
    let be = null;
    if (m.remaining > 0) { const i = p.wd.findIndex(x => m.recovered + x >= m.in); be = i >= 0 ? i : null; }
    const at = d => ({ cap: p.cap[Math.min(d, proj.days)], wd: p.wd[Math.min(d, proj.days)] });
    return { s, p, be, at };
  });
  const marks = [30, 90, 180, 365, 730].filter(d => d <= proj.days);
  const u = unitLabel();
  return `
  <h2>Projection</h2>
  <p class="hint">What the loop could look like if returns stay at a fixed rate. Real returns change daily and loss days happen — treat this as a guide, not a forecast. It also ignores the platform risk of keeping capital there.</p>
  <form class="inline" data-form="projection">
    <label>Capital in the loop (BTC)<input type="number" name="capital" step="0.00000001" min="0" value="${(+capital).toFixed(8)}" style="width:150px"></label>
    <label>Return per 30 days (%)<input type="number" name="per30" step="0.01" value="${(per30 * 100).toFixed(2)}" style="width:110px"></label>
    <label>Look ahead<select name="days">${[90, 180, 365, 730].map(d => `<option value="${d}" ${d === proj.days ? 'selected' : ''}>${d === 730 ? '2 years' : d === 365 ? '1 year' : d + ' days'}</option>`).join('')}</select></label>
    <label>Custom reinvest share of profit (%)<input type="number" name="custom" min="0" max="100" step="5" value="${proj.custom}" style="width:110px"></label>
    <button class="primary">Update</button>
    <button type="button" data-act="proj-reset">Use my current figures</button>
  </form>
  <p class="hint">Starting point: ${fmtAmtU(capital)} working at ${fmtPct(per30, 2)} per 30 days ≈ ${fmtAmtU(capital * per30)} profit per 30 days${fiat(capital * per30) ? ` (${fiat(capital * per30)})` : ''}. Money in: ${fmtAmtU(m.in)}, already back: ${fmtAmtU(m.recovered)}.</p>

  <div class="table-wrap"><table>
    <thead><tr><th>Profit reinvested</th>${marks.map(d => `<th class="n">After ${d === 730 ? '2 years' : d === 365 ? '1 year' : d + ' days'}<br><small>withdrawn · capital (${u})</small></th>`).join('')}<th class="n">Monthly payout at end</th><th class="n">All money in back by</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td><b>${fmtPct(r.s, 0)}</b> ${r.s === 0 ? '<small>(your plan)</small>' : r.s === 1 ? '<small>(withdraw nothing)</small>' : ''}</td>
      ${marks.map(d => `<td class="n">${fmtAmt(r.at(d).wd)}<br><small class="usd">${fmtAmt(r.at(d).cap)}</small></td>`).join('')}
      <td class="n">${fmtAmt(r.p.cap.at(-1) * rate * CONTRACT_DAYS * (1 - r.s))}<br><small class="usd">${fiat(r.p.cap.at(-1) * rate * CONTRACT_DAYS * (1 - r.s))}</small></td>
      <td class="n">${m.remaining <= 0 ? 'already back' : r.be != null ? `${fmtDate(addDays(start, r.be))}<br><small class="usd">${r.be} days</small>` : `not within ${proj.days} days`}</td>
    </tr>`).join('')}</tbody>
  </table></div>

  <div class="charts" style="margin-top:12px">
    <div class="chart-box"><h3>Total withdrawn to your wallet (${u})</h3><div class="canvas"><canvas id="chProjW"></canvas></div></div>
    <div class="chart-box"><h3>Capital in the loop (${u})</h3><div class="canvas"><canvas id="chProjC"></canvas></div></div>
  </div>`;
}

function drawProjection(R) {
  if (typeof Chart === 'undefined' || !$('#chProjW')) return;
  const { m } = R;
  const capital = proj.capital ?? (m.onPlatform > 0 ? m.onPlatform : m.in);
  const per30 = proj.per30 ?? (isFinite(m.windows.d30.per30) ? m.windows.d30.per30 : m.windows.all.per30);
  const rate = per30 / CONTRACT_DAYS;
  const { v, base, yAxis } = chartTheme();
  const k = unitScale();
  const shares = [...new Set([0, 0.25, 0.5, 1, proj.custom / 100])].sort((a, b) => a - b);
  const colors = [v('--chart-1'), v('--chart-2'), v('--chart-3'), v('--muted'), v('--warn')];
  const start = m.last || todayIso();
  const step = proj.days > 365 ? 7 : proj.days > 180 ? 3 : 1;
  const idx = [];
  for (let i = 0; i <= proj.days; i += step) idx.push(i);
  const labels = idx.map(i => dayLabel(addDays(start, i)));
  const sets = shares.map((s, i) => ({ s, p: project(capital, rate, proj.days, s), color: colors[i % colors.length] }));
  const lineOpts = { pointRadius: 0, borderWidth: 2 };
  charts.projW = new Chart($('#chProjW'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        ...sets.filter(x => x.s < 1).map(x => ({ label: `${fmtPct(x.s, 0)} reinvested`, data: idx.map(i => x.p.wd[i] * k), borderColor: x.color, ...lineOpts })),
        ...(m.remaining > 0 ? [{ label: 'Money in still to recover', data: idx.map(() => m.remaining * k), borderColor: v('--neg'), borderDash: [6, 4], ...lineOpts, borderWidth: 1.5 }] : []),
      ],
    },
    options: { ...base, scales: { ...base.scales, y: yAxis({ beginAtZero: true }) } },
  });
  charts.projC = new Chart($('#chProjC'), {
    type: 'line',
    data: { labels, datasets: sets.map(x => ({ label: `${fmtPct(x.s, 0)} reinvested`, data: idx.map(i => x.p.cap[i] * k), borderColor: x.color, ...lineOpts })) },
    options: { ...base, scales: { ...base.scales, y: yAxis() } },
  });
}

function renderMoney(R) {
  const scope = currentScope;
  const cs = cyclesSorted();
  const deposits = (scope === 'all' ? data.deposits : data.deposits.filter(d => d.cycleId === scope)).slice().sort(byDate);
  const checks = data.balanceChecks.filter(c => scope === 'all' || cycleIdForDate(c.date) === scope).sort(byDate);
  const payouts = data.payouts.filter(p => scope === 'all' || cycleIdForDate(p.requested) === scope);
  const cycleName = id => esc(data.cycles.find(c => c.id === id)?.name || '—');
  const defaultCycle = scope !== 'all' ? scope : cs.at(-1)?.id;
  const u = unitLabel();
  const cur = prefs.currency;
  return `<div class="cols"><div>
  <h2>Deposits (money in)</h2>
  <p class="hint">Add every amount of BTC you send to the platform — the reports don't show deposits. When a new cycle starts with the leftover balance, add that as "Carried over". Amounts are entered in BTC.</p>
  ${cs.length ? `<form class="inline" data-form="deposit">
    <label>Date<input type="date" name="date" value="${todayIso()}" required></label>
    <label>BTC<input type="number" name="btc" step="0.00000001" min="0" required style="width:150px"></label>
    <label>Type<select name="kind"><option value="new">New BTC sent in</option><option value="carry">Carried over from previous cycle</option></select></label>
    <label>Cycle<select name="cycleId">${cs.map(c => `<option value="${c.id}" ${c.id === defaultCycle ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
    <label>Note<input name="note" style="width:220px"></label>
    <button class="primary">Add deposit</button>
  </form>` : `<div class="empty">Start a cycle first on the <b>Settings</b> tab.</div>`}
  ${deposits.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Date</th><th>Cycle</th><th>Type</th><th class="n">${u}</th><th class="n">${cur} now</th><th>Note</th><th></th></tr></thead>
    <tbody>${deposits.map(d => editing?.type === 'deposit' && editing.id === d.id
      ? `<tr data-edit="deposit" data-id="${d.id}"><td><input type="date" name="date" value="${d.date}"></td>
        <td><select name="cycleId">${cs.map(c => `<option value="${c.id}" ${c.id === d.cycleId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></td>
        <td><select name="kind"><option value="new" ${d.kind !== 'carry' ? 'selected' : ''}>New BTC</option><option value="carry" ${d.kind === 'carry' ? 'selected' : ''}>Carried over</option></select></td>
        <td class="n"><input type="number" name="btc" step="0.00000001" min="0" value="${d.btc}" style="width:140px" title="BTC"></td><td></td>
        <td><input name="note" value="${esc(d.note)}" style="width:100%;min-width:200px"></td>
        <td class="actions"><button class="primary" data-act="save-edit">Save</button><button data-act="cancel-edit">Cancel</button></td></tr>`
      : `<tr><td>${fmtDate(d.date)}</td><td>${cycleName(d.cycleId)}</td><td>${d.kind === 'carry' ? 'Carried over' : 'New BTC'}</td>
        <td class="n">${fmtAmt(d.btc)}</td><td class="n">${fiat(d.btc)}</td><td class="note">${esc(d.note)}</td>
        <td class="actions"><button data-act="edit" data-type="deposit" data-id="${d.id}">Edit</button><button class="danger" data-act="del-deposit" data-id="${d.id}">Delete</button></td></tr>`).join('')}</tbody>
  </table></div>` : ''}
  </div><div>

  <h2>Payouts to your wallet</h2>
  <p class="hint">From the payout report.</p>
  ${payouts.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Requested</th><th>Processed</th><th>Status</th><th class="n">${u}</th><th class="n">${cur} now</th><th>TX</th></tr></thead>
    <tbody>${payouts.map(p => `<tr><td>${fmtDate(p.requested)}</td><td>${fmtDate(p.processed)}</td><td>${esc(p.status)}</td>
      <td class="n">${fmtAmt(p.btc)}</td><td class="n">${fiat(p.btc)}</td><td title="${esc(p.tx)}">${esc(p.tx.slice(0, 12))}${p.tx.length > 12 ? '…' : ''}</td></tr>`).join('')}</tbody>
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
    <thead><tr><th>Date</th><th class="n">Dashboard (${u})</th><th class="n">Calculated</th><th class="n">Difference</th><th>Note</th><th></th></tr></thead>
    <tbody>${checks.map(c => {
      if (editing?.type === 'check' && editing.id === c.id) {
        return `<tr data-edit="check" data-id="${c.id}"><td><input type="date" name="date" value="${c.date}"></td>
          <td class="n"><input type="number" name="btc" step="0.00000001" min="0" value="${c.btc}" style="width:140px" title="BTC"></td><td></td><td></td>
          <td><input name="note" value="${esc(c.note)}" style="width:100%;min-width:160px"></td>
          <td class="actions"><button class="primary" data-act="save-edit">Save</button><button data-act="cancel-edit">Cancel</button></td></tr>`;
      }
      const calc = balanceAt(scope, c.date); const diff = c.btc - calc;
      return `<tr><td>${fmtDate(c.date)}</td>
      <td class="n">${fmtAmt(c.btc)}</td><td class="n">${fmtAmt(calc)}</td><td class="n ${Math.abs(diff) < 1e-6 ? 'pos' : 'warn'}">${fmtAmt(diff, true)}</td>
      <td class="note">${esc(c.note)}</td><td class="actions"><button data-act="edit" data-type="check" data-id="${c.id}">Edit</button><button class="danger" data-act="del-check" data-id="${c.id}">Delete</button></td></tr>`; }).join('')}</tbody>
  </table></div>` : ''}
  </div></div>`;
}

function renderSettings() {
  const cs = cyclesSorted();
  const counts = `${plural(data.purchases.length, 'contract')} · ${plural(new Set(data.earnings.map(e => e.date)).size, 'day')} of earnings · ${plural(data.payouts.length, 'payout')} · ${data.summaries.length} contract results`;
  const seg = (pref, opts) => `<div class="seg" data-pref="${pref}">${opts.map(([v, l]) => `<button data-v="${v}" class="${prefs[pref] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  return `<div class="cols"><div>
  <h2>Cycles</h2>
  <p class="hint">A cycle is one run of the loop, starting from a fresh contract. Everything dated on or after a cycle's start date (and before the next cycle's start) belongs to it. Thresholds are in BTC.</p>
  ${cs.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Start</th><th class="n">Reinvest at (BTC)</th><th class="n">Withdraw at (BTC)</th><th>Notes</th><th></th></tr></thead>
    <tbody>${cs.map(c => `<tr data-cycle="${c.id}">
      <td><input name="name" value="${esc(c.name)}" style="width:140px"></td>
      <td><input type="date" name="start" value="${c.start}"></td>
      <td class="n"><input type="number" step="0.00000001" min="0" name="reinvestThreshold" value="${c.reinvestThreshold ?? ''}" style="width:130px"></td>
      <td class="n"><input type="number" step="0.00000001" min="0" name="withdrawThreshold" value="${c.withdrawThreshold ?? ''}" style="width:130px"></td>
      <td><input name="notes" value="${esc(c.notes)}" style="width:100%;min-width:200px"></td>
      <td class="actions"><button class="danger" data-act="del-cycle" data-id="${c.id}">Delete</button></td></tr>`).join('')}</tbody>
  </table></div>` : ''}

  <h2>Start a new cycle</h2>
  <p class="hint">Set the start date to the day of the first new contract. If the previous cycle's contracts are still paying out, wait until they've ended so their last payouts stay in that cycle.</p>
  <form class="inline" data-form="cycle">
    <label>Name<input name="name" value="Cycle ${cs.filter(c => !/test/i.test(c.name)).length + 1}" required style="width:140px"></label>
    <label>Start date<input type="date" name="start" value="${todayIso()}" required></label>
    <label>Carried over BTC<input type="number" name="carry" step="0.00000001" min="0" style="width:140px" placeholder="0"></label>
    <label>New BTC sent in<input type="number" name="fresh" step="0.00000001" min="0" style="width:140px" placeholder="0"></label>
    <label>Reinvest at<input type="number" name="reinvestThreshold" step="0.00000001" min="0" style="width:120px"></label>
    <label>Withdraw at<input type="number" name="withdrawThreshold" step="0.00000001" min="0" style="width:120px"></label>
    <button class="primary">Create cycle</button>
  </form>

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
    <li>Record any BTC you send in on the <b>Money in &amp; out</b> tab. Reports don't show deposits.</li>
    <li>Now and then add a <b>balance check</b> from the dashboard to confirm the numbers line up.</li>
  </ol>
  <p class="hint" style="margin:10px 0 0">Your data never leaves this computer. The only thing the app fetches from the internet is the BTC price. Version ${APP_VERSION}.</p></div>
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
  $('#tabs').addEventListener('click', e => {
    const t = e.target.closest('button[data-tab]');
    if (t) { currentTab = t.dataset.tab; editing = null; render(); }
  });
  $('#scope').addEventListener('change', e => { currentScope = e.target.value; proj.capital = proj.per30 = null; render(); });
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
    else if (act === 'toggle-month') { const ym = b.dataset.ym; collapsedMonths.has(ym) ? collapsedMonths.delete(ym) : collapsedMonths.add(ym); render(); }
    else if (act === 'proj-reset') { proj.capital = proj.per30 = null; render(); }
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
    if (e.target.id === 'backupInput' && e.target.files[0]) {
      try {
        const restored = migrate(JSON.parse(await e.target.files[0].text()));
        if (confirm('Replace all current data with this backup?')) { data = restored; save(); render(); toast('Backup restored'); }
      } catch (err) { toast('Not a valid backup file: ' + err.message, true); }
      e.target.value = '';
      return;
    }
    if (e.target.dataset.act === 'group-daily') { groupDaily = e.target.checked; render(); return; }
    const row = e.target.closest('tr[data-cycle]');
    if (row) {
      const c = data.cycles.find(x => x.id === row.dataset.cycle);
      const f = e.target.name;
      if (f === 'start' && !isIso(e.target.value)) return;
      c[f] = /Threshold$/.test(f) ? (e.target.value === '' ? null : num(e.target.value)) : e.target.value;
      save(); render();
    }
  });

  document.addEventListener('submit', e => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    if (form.dataset.form === 'projection') {
      proj.capital = num(f.capital) > 0 ? num(f.capital) : null;
      proj.per30 = isFinite(num(f.per30)) ? num(f.per30) / 100 : null;
      proj.days = parseInt(f.days, 10) || 365;
      proj.custom = Math.min(100, Math.max(0, num(f.custom) || 0));
      render();
      return;
    }
    if (form.dataset.form === 'deposit') {
      data.deposits.push({ id: uid(), cycleId: f.cycleId, date: f.date, btc: num(f.btc), kind: f.kind, note: f.note.trim() });
    } else if (form.dataset.form === 'check') {
      data.balanceChecks.push({ id: uid(), date: f.date, btc: num(f.btc), note: f.note.trim() });
    } else if (form.dataset.form === 'cycle') {
      if (data.cycles.some(c => c.start === f.start)) { toast('A cycle already starts on that date.', true); return; }
      const id = uid();
      data.cycles.push({ id, name: f.name.trim(), start: f.start, reinvestThreshold: f.reinvestThreshold ? num(f.reinvestThreshold) : null, withdrawThreshold: f.withdrawThreshold ? num(f.withdrawThreshold) : null, notes: '' });
      if (num(f.carry) > 0) data.deposits.push({ id: uid(), cycleId: id, date: f.start, btc: num(f.carry), kind: 'carry', note: 'Balance carried over' });
      if (num(f.fresh) > 0) data.deposits.push({ id: uid(), cycleId: id, date: f.start, btc: num(f.fresh), kind: 'new', note: 'New BTC sent in' });
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

// Exposed for testing and for loading data from the console.
window.cloudMining = { importCsv, compute, warnings, project, get data() { return data; }, set data(v) { data = migrate(v); render(); }, save, render };

init();
