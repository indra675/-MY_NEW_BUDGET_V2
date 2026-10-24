const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PASSCODE = process.env.APP_PASSCODE || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- validation ----------
const PAYS = ['Cash', 'UPI', 'Card'];
const num = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isMonth = s => /^\d{4}-\d{2}$/.test(s);

function cleanDaily(b) {
  const amount = num(b.amount), cat = str(b.cat, 40), date = str(b.date, 10);
  if (amount === null || !cat || !isDate(date)) return null;
  return { date, amount, cat, pay: PAYS.includes(b.pay) ? b.pay : 'Cash', note: str(b.note, 60) };
}
function cleanMonthly(b) {
  const amount = num(b.amount), name = str(b.name, 40), recurring = !!b.recurring, month = str(b.month, 7);
  if (amount === null || !name || (!recurring && !isMonth(month))) return null;
  return { name, amount, recurring, month: recurring ? '' : month, pay: PAYS.includes(b.pay) ? b.pay : 'UPI', note: str(b.note, 60) };
}
const cleanSettings = b => ({ salary: num(b.salary) || 0, savings: num(b.savings) || 0 });
const CLEAN = { daily: cleanDaily, monthly: cleanMonthly };

// ---------- convert data saved by the OLD version of the app ----------
function fromLegacy(old) {
  old = old || {};
  return {
    settings: { salary: Number(old.salary) || 0, savings: Number(old.savings) || 0 },
    daily: (old.expenses || []).map(e => ({
      id: String(e.id), date: e.date, amount: Number(e.amount) || 0, cat: e.cat || 'Other', pay: e.pay || 'Cash', note: e.note || '',
    })),
    // old "fixed expenses" repeated every month, so they become "repeat every month" monthly expenses
    monthly: (old.fixed || []).map((f, i) => ({
      id: 'legacy-fixed-' + i, name: f.name, amount: Number(f.amount) || 0, recurring: true, month: '', pay: 'UPI', note: '',
    })),
  };
}

// ---------- storage: MongoDB if MONGODB_URI is set, otherwise a local file (testing only) ----------
let store;
if (MONGODB_URI) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGODB_URI);
  const db = () => client.db('budget');
  // daily expenses, monthly expenses and settings each live in their own collection
  const col = name => db().collection(name);
  const toItem = ({ _id, ...rest }) => ({ id: _id, ...rest });

  async function migrateIfNeeded() {
    if (await col('settings').findOne({ _id: 'main' })) return;
    const oldDoc = await col('state').findOne({ _id: 'main' }); // collection used by the old version
    const m = fromLegacy(oldDoc && oldDoc.state);
    for (const kind of ['daily', 'monthly']) {
      if (!m[kind].length) continue;
      await col(kind).bulkWrite(m[kind].map(({ id, ...rest }) => ({
        updateOne: { filter: { _id: id }, update: { $setOnInsert: rest }, upsert: true },
      })));
    }
    await col('settings').updateOne({ _id: 'main' }, { $setOnInsert: m.settings }, { upsert: true });
  }

  store = {
    async getAll() {
      await migrateIfNeeded();
      const s = await col('settings').findOne({ _id: 'main' });
      const daily = (await col('daily').find().toArray()).map(toItem);
      const monthly = (await col('monthly').find().toArray()).map(toItem);
      return { settings: { salary: (s && s.salary) || 0, savings: (s && s.savings) || 0 }, daily, monthly };
    },
    async setSettings(s) { await col('settings').updateOne({ _id: 'main' }, { $set: s }, { upsert: true }); },
    async add(kind, item) { const { id, ...rest } = item; await col(kind).insertOne({ _id: id, ...rest }); },
    async remove(kind, id) { await col(kind).deleteOne({ _id: id }); },
  };
} else {
  const file = path.join(__dirname, 'data.json');
  let mem = null;
  try { mem = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch (e) { mem = null; }
  if (mem && mem.expenses) mem = fromLegacy(mem);
  if (!mem || !mem.daily) mem = { settings: { salary: 0, savings: 0 }, daily: [], monthly: [] };
  const flush = () => fs.writeFileSync(file, JSON.stringify(mem));
  store = {
    async getAll() { return mem; },
    async setSettings(s) { mem.settings = s; flush(); },
    async add(kind, item) { mem[kind].push(item); flush(); },
    async remove(kind, id) { mem[kind] = mem[kind].filter(x => x.id !== id); flush(); },
  };
  console.log('⚠️  No MONGODB_URI - using local file (data is lost on Render redeploys).');
}

// ---------- routes ----------
const auth = (req, res, next) => {
  if (PASSCODE && req.header('x-passcode') !== PASSCODE) return res.status(401).json({ error: 'bad passcode' });
  next();
};
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'db error' }); });

app.get('/api/data', auth, wrap(async (req, res) => { res.json(await store.getAll()); }));

app.put('/api/settings', auth, wrap(async (req, res) => {
  const s = cleanSettings(req.body || {});
  await store.setSettings(s);
  res.json({ settings: s });
}));

['daily', 'monthly'].forEach(kind => {
  app.post('/api/' + kind, auth, wrap(async (req, res) => {
    const item = CLEAN[kind](req.body || {});
    if (!item) return res.status(400).json({ error: 'invalid data' });
    item.id = crypto.randomUUID();
    await store.add(kind, item);
    res.json({ item });
  }));
  app.delete('/api/' + kind + '/:id', auth, wrap(async (req, res) => {
    await store.remove(kind, req.params.id);
    res.json({ ok: true });
  }));
});

app.listen(PORT, () => console.log('Running on port ' + PORT));
