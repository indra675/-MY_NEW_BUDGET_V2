// All data lives on the server (MongoDB). Nothing is stored in the browser except the passcode.
const $ = id => document.getElementById(id);
const inr = n => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return ymd(d); };
const diffDays = (a, b) => Math.round((parseDay(b) - parseDay(a)) / 86400000);
const todayStr = () => ymd(new Date());
const dmy = s => s.split('-').reverse().join('-');
const dm = s => s.slice(8) + '-' + s.slice(5, 7);
const nice = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);
const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo, 0).getDate(); };

let data = { settings: { salary: 0, savings: 0 }, daily: [], monthly: [] };
let loaded = false;

// ---------- server ----------
let pass = localStorage.getItem('btPass') || '';
function setStatus(t) { $('syncStatus').textContent = t; }

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-passcode': pass },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    pass = prompt('Enter your passcode') || '';
    if (!pass) throw new Error('no passcode');
    localStorage.setItem('btPass', pass);
    return api(method, url, body);
  }
  if (!r.ok) throw new Error('Server error ' + r.status);
  return r.json();
}

// run a server change; the screen only updates after the server confirms it was saved
async function change(fn) {
  if (!loaded) { alert('Not connected to the server yet. Please wait or refresh the page.'); return false; }
  setStatus('⏳ Saving...');
  try { await fn(); setStatus('☁️ Saved online'); render(); return true; }
  catch (e) { setStatus('⚠️ Not saved - check internet and try again'); alert('Could not save. Please check your internet connection and try again.'); return false; }
}

async function load() {
  setStatus('⏳ Loading...');
  try {
    const d = await api('GET', '/api/data');
    data = { settings: d.settings, daily: d.daily, monthly: d.monthly };
    loaded = true;
    $('salary').value = data.settings.salary || '';
    $('savings').value = data.settings.savings || '';
    setStatus('☁️ Synced');
  } catch (e) { setStatus('⚠️ Cannot reach server - refresh to retry'); }
  render();
}

// ---------- calculations ----------
const monthlyFor = m => data.monthly.filter(x => x.recurring || x.month === m);
const dailyIn = m => data.daily.filter(e => e.date.startsWith(m));
const spendable = m => data.settings.salary - sum(monthlyFor(m), x => x.amount) - data.settings.savings;
// what you can spend on a given day: money still available in that month ÷ days left (today included).
// Anything unspent (or overspent) on earlier days is carried into the following days automatically.
function allowance(date) {
  const m = date.slice(0, 7);
  const before = sum(data.daily.filter(e => e.date.startsWith(m) && e.date < date), e => e.amount);
  const remaining = daysIn(m) - Number(date.slice(8)) + 1;
  return (spendable(m) - before) / remaining;
}
const spentOn = date => sum(data.daily.filter(e => e.date === date), e => e.amount);
const dayTitle = s => { const l = dayLabel(s); return l === dmy(s) ? l : `${l} · ${dmy(s)}`; };
function dayLabel(s) {
  const d = diffDays(todayStr(), s);
  return d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : d === -1 ? 'Yesterday' : dmy(s);
}

// ---------- charts ----------
const COLORS = ['#6366f1', '#ec4899', '#10b981', '#f59e0b', '#06b6d4', '#8b5cf6', '#f43f5e', '#84cc16', '#0ea5e9', '#64748b'];
function pie(el, obj, total, emptyText) {
  el.innerHTML = '';
  const keys = Object.keys(obj).sort((a, b) => obj[b] - obj[a]);
  if (!keys.length || !total) { el.innerHTML = `<p class="muted">${emptyText || 'No data yet.'}</p>`; return; }
  let acc = 0; const stops = [];
  keys.forEach((k, i) => {
    const start = acc / total * 360; acc += obj[k]; const end = acc / total * 360;
    stops.push(`${COLORS[i % COLORS.length]} ${start}deg ${end}deg`);
  });
  const wrap = document.createElement('div'); wrap.className = 'pie-wrap';
  const p = document.createElement('div'); p.className = 'pie';
  p.style.background = `conic-gradient(${stops.join(',')})`;
  const legend = document.createElement('ul'); legend.className = 'legend';
  keys.forEach((k, i) => {
    const li = document.createElement('li');
    const dot = document.createElement('i'); dot.style.background = COLORS[i % COLORS.length];
    const t = document.createElement('span'); t.textContent = k;
    const v = document.createElement('b'); v.textContent = `${inr(obj[k])} (${(obj[k] / total * 100).toFixed(0)}%)`;
    li.append(dot, t, v); legend.appendChild(li);
  });
  wrap.append(p, legend); el.appendChild(wrap);
}
const groupBy = (list, keyFn) => { const o = {}; list.forEach(e => { const k = keyFn(e); o[k] = (o[k] || 0) + e.amount; }); return o; };

function mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function kv(label, value, cls) { const d = mk('div', 'kv ' + (cls || '')); d.append(mk('span', '', label), mk('b', '', value)); return d; }

// ---------- daily report (selected day + the next day) ----------
function renderDay() {
  const day = $('rDate').value || todayStr();
  const next = addDays(day, 1);
  document.querySelectorAll('[data-day]').forEach(b => b.classList.toggle('on', addDays(todayStr(), Number(b.dataset.day)) === day));

  const a = $('dayA'); a.innerHTML = '';
  const allow = allowance(day), sp = spentOn(day), left = allow - sp;
  a.append(mk('h3', '', dayTitle(day)),
    kv('Spent', inr(sp), 'big'), kv('Allowance for the day', inr(allow)),
    kv(left < 0 ? 'Over budget by' : 'Left to spend', inr(Math.abs(left)), left < 0 ? 'bad' : 'good'),
    kv('Entries', String(data.daily.filter(e => e.date === day).length)));

  const b = $('dayB'); b.innerHTML = '';
  const allowN = allowance(next), spN = spentOn(next), leftN = allowN - spN;
  b.append(mk('h3', '', dayTitle(next)),
    kv('Budget available', inr(allowN), 'big'), kv('Already added', inr(spN)),
    kv(leftN < 0 ? 'Over budget by' : 'Left to spend', inr(Math.abs(leftN)), leftN < 0 ? 'bad' : 'good'),
    kv('Carry-over from previous day', (allowN - allow >= 0 ? '+' : '−') + inr(Math.abs(allowN - allow))));

  const items = data.daily.filter(e => e.date === day);
  $('dayPieTitle').textContent = `Spent on (${dayLabel(day).toLowerCase()})`;
  pie($('dayPie'), groupBy(items, e => nice(e.cat.trim().toLowerCase())), sum(items, e => e.amount), 'Nothing spent on this day.');
  const ul = $('dayList'); ul.innerHTML = '';
  if (!items.length) ul.append(mk('li', '', 'No entries on this day.'));
  items.forEach(e => {
    const li = mk('li'); const s = mk('span', '', e.cat); if (e.note) s.append(mk('small', '', e.note));
    li.append(s, mk('b', '', inr(e.amount))); ul.append(li);
  });
}

// ---------- date range: ring with total, days in range, days with entries ----------
function renderRange() {
  let from = $('rFrom').value, to = $('rTo').value;
  const box = $('rangeBox'); box.innerHTML = '';
  if (!from || !to) { box.append(mk('p', 'muted', 'Pick a start and end date.')); return; }
  if (from > to) [from, to] = [to, from];
  const totalDays = diffDays(from, to) + 1;
  if (totalDays > 366) { box.append(mk('p', 'muted', 'Please pick a range of up to one year.')); return; }

  const perDay = {};
  data.daily.filter(e => e.date >= from && e.date <= to).forEach(e => { perDay[e.date] = (perDay[e.date] || 0) + e.amount; });
  const dates = Object.keys(perDay).sort();
  const total = sum(dates, d => perDay[d]);
  const entries = data.daily.filter(e => e.date >= from && e.date <= to).length;
  const colorOf = i => `hsl(${(i * 47) % 360} 70% 55%)`;

  const flex = mk('div', 'range-flex');
  const ringWrap = mk('div', 'ring-wrap'); const ring = mk('div', 'pie');
  if (total > 0) {
    let acc = 0; const stops = [];
    dates.forEach((d, i) => { const s = acc / total * 360; acc += perDay[d]; stops.push(`${colorOf(i)} ${s}deg ${acc / total * 360}deg`); });
    ring.style.background = `conic-gradient(${stops.join(',')})`;
  } else ring.style.background = 'var(--line)';
  const center = mk('div', 'ring-center'); center.append(mk('b', '', inr(total)), mk('small', '', from === to ? dm(from) : `${dm(from)} → ${dm(to)}`));
  ringWrap.append(ring, center);

  const side = mk('div', 'range-side');
  const stats = mk('div', 'stats');
  const stat = (l, v) => { const s = mk('div', 'stat', l); s.append(mk('b', '', v)); return s; };
  stats.append(stat('📅 Date range', from === to ? dmy(from) : `${dmy(from)} → ${dmy(to)}`),
    stat('🗓️ Days in range', String(totalDays)),
    stat('✍️ Days with entries', `${dates.length} of ${totalDays}`),
    stat('🧾 Total entries', String(entries)),
    stat('💸 Total spent', inr(total)),
    stat('📉 Average per day', inr(total / totalDays)));
  side.append(stats);

  const legend = mk('ul', 'legend scroll-y'); legend.style.marginTop = '12px';
  if (!dates.length) legend.append(mk('li', 'muted', 'No expenses in these dates.'));
  dates.forEach((d, i) => {
    const li = mk('li'); const dot = mk('i'); dot.style.background = colorOf(i);
    li.append(dot, mk('span', '', dmy(d)), mk('b', '', `${inr(perDay[d])} (${(perDay[d] / total * 100).toFixed(0)}%)`)); legend.append(li);
  });
  side.append(legend);
  flex.append(ringWrap, side); box.append(flex);
}

// ---------- main render ----------
function render() {
  const m = $('month').value || todayStr().slice(0, 7);
  const list = dailyIn(m).sort((a, b) => a.date < b.date ? 1 : -1);
  const monthly = monthlyFor(m);
  const monthlyTotal = sum(monthly, x => x.amount);
  const spent = sum(list, e => e.amount);
  const left = spendable(m) - spent;
  const tod = todayStr();
  const todayLeft = allowance(tod) - spentOn(tod);
  const s = data.settings;
  const used = s.salary ? (monthlyTotal + spent + s.savings) / s.salary * 100 : 0;

  $('sSalary').textContent = inr(s.salary);
  $('sMonthly').textContent = inr(monthlyTotal);
  $('sSavings').textContent = inr(s.savings);
  $('sSpent').textContent = inr(spent);
  $('sLeft').textContent = inr(left);
  $('sLeft').parentElement.className = 'card hero ' + (left < 0 ? 'bad' : 'good');
  $('sDaily').textContent = inr(spendable(m) / daysIn(m));
  $('sToday').textContent = inr(todayLeft);
  $('sToday').parentElement.className = 'card ' + (todayLeft < 0 ? 'bad' : '');
  $('sPct').textContent = used.toFixed(1) + '%';
  $('bar').style.width = Math.min(used, 100) + '%';

  renderDay();
  renderRange();

  // pies for the selected month
  $('catList').innerHTML = '';
  [...new Set(data.daily.map(e => nice(e.cat.trim().toLowerCase())))].forEach(n => { const o = document.createElement('option'); o.value = n; $('catList').appendChild(o); });
  pie($('catPie'), groupBy(list, e => nice(e.cat.trim().toLowerCase())), spent, 'No daily expenses this month.');
  pie($('payPie'), groupBy(list, e => e.pay), spent, 'No daily expenses this month.');
  pie($('monPie'), groupBy(monthly, x => nice(x.name.trim().toLowerCase())), monthlyTotal, 'No monthly expenses this month.');

  // monthly table
  const mb = $('monRows'); mb.innerHTML = '';
  monthly.forEach(x => {
    const tr = mk('tr');
    tr.append(mk('td', '', x.name));
    const ta = mk('td'); ta.append(x.recurring ? mk('span', 'pill', '🔁 Every month') : mk('span', '', x.month)); tr.append(ta);
    const tp = mk('td'); tp.append(mk('span', 'tag', x.pay)); tr.append(tp);
    tr.append(mk('td', 'r', inr(x.amount)));
    const td = mk('td'); const del = mk('button', 'x', '×'); del.title = 'Delete';
    del.onclick = () => { if (confirm('Delete this monthly expense' + (x.recurring ? ' (it repeats every month, so it will be removed from all months)' : '') + '?')) change(async () => { await api('DELETE', '/api/monthly/' + x.id); data.monthly = data.monthly.filter(z => z.id !== x.id); }); };
    td.append(del); tr.append(td); mb.append(tr);
  });
  $('monEmpty').style.display = monthly.length ? 'none' : 'block';

  // daily table
  const tb = $('rows'); tb.innerHTML = '';
  list.forEach(e => {
    const tr = mk('tr');
    tr.append(mk('td', '', dmy(e.date)), mk('td', '', e.cat));
    const tp = mk('td'); tp.append(mk('span', 'tag', e.pay)); tr.append(tp);
    tr.append(mk('td', '', e.note || ''), mk('td', 'r', inr(e.amount)));
    const td = mk('td'); const del = mk('button', 'x', '×'); del.title = 'Delete';
    del.onclick = () => { if (confirm('Delete this expense?')) change(async () => { await api('DELETE', '/api/daily/' + e.id); data.daily = data.daily.filter(z => z.id !== e.id); }); };
    td.append(del); tr.append(td); tb.append(tr);
  });
  $('empty').style.display = list.length ? 'none' : 'block';
}

// ---------- events ----------
$('expForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = { date: $('eDate').value, amount: parseFloat($('eAmt').value), cat: nice($('eCat').value.trim().toLowerCase()), pay: $('ePay').value, note: $('eNote').value.trim() };
  if (!(body.amount >= 0)) return;
  const ok = await change(async () => { const r = await api('POST', '/api/daily', body); data.daily.push(r.item); });
  if (ok) { $('eAmt').value = ''; $('eNote').value = ''; $('eCat').value = ''; $('month').value = body.date.slice(0, 7); render(); }
});

$('monForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const body = { name: $('mName').value.trim(), amount: parseFloat($('mAmt').value), recurring: $('mRepeat').checked, month: $('mMonth').value, pay: $('mPay').value };
  if (!body.name || !(body.amount >= 0)) return;
  const ok = await change(async () => { const r = await api('POST', '/api/monthly', body); data.monthly.push(r.item); });
  if (ok) { $('mName').value = ''; $('mAmt').value = ''; if (!body.recurring) $('month').value = body.month; render(); }
});
$('mRepeat').addEventListener('change', () => { $('mMonth').disabled = $('mRepeat').checked; $('mMonth').required = !$('mRepeat').checked; });

let settingsTimer;
function saveSettings() {
  data.settings = { salary: parseFloat($('salary').value) || 0, savings: parseFloat($('savings').value) || 0 };
  render(); setStatus('⏳ Saving...');
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(async () => {
    try { await api('PUT', '/api/settings', data.settings); setStatus('☁️ Saved online'); }
    catch (e) { setStatus('⚠️ Not saved - check internet and try again'); }
  }, 600);
}
$('salary').addEventListener('input', () => { if (loaded) saveSettings(); });
$('savings').addEventListener('input', () => { if (loaded) saveSettings(); });

$('month').addEventListener('change', render);
$('rDate').addEventListener('change', renderDay);
$('rFrom').addEventListener('change', renderRange);
$('rTo').addEventListener('change', renderRange);
document.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => { $('rDate').value = addDays(todayStr(), Number(b.dataset.day)); renderDay(); }));

function download(name, lines) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = name; a.click();
}
const q = s => '"' + String(s).replace(/"/g, '""') + '"';
$('csv').addEventListener('click', () => download(`daily-expenses-${$('month').value}.csv`,
  ['Date,Spent on,Paid by,Note,Amount'].concat(dailyIn($('month').value).sort((a, b) => a.date < b.date ? 1 : -1).map(e => [e.date, q(e.cat), e.pay, q(e.note || ''), e.amount].join(',')))));
$('csvM').addEventListener('click', () => download(`monthly-expenses-${$('month').value}.csv`,
  ['Name,Applies to,Paid by,Amount'].concat(monthlyFor($('month').value).map(x => [q(x.name), x.recurring ? 'Every month' : x.month, x.pay, x.amount].join(',')))));

// ---------- start ----------
const t0 = todayStr();
$('month').value = t0.slice(0, 7);
$('mMonth').value = t0.slice(0, 7);
$('eDate').value = t0;
$('rDate').value = t0;
$('rFrom').value = addDays(t0, -2);
$('rTo').value = t0;
render();
load();
