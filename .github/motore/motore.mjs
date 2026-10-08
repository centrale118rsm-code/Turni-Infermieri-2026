// Motore delle notifiche e dei calendari del telefono.
// Gira su GitHub Actions ogni 15 minuti (vedi .github/workflows/motore.yml):
//  1. apre l'app pubblicata in un browser invisibile con ?server=1 e legge serverExport();
//  2. scrive cal/<nome>.ics (i calendari personali che il telefono controlla da solo);
//  3. confronta i turni con il giro precedente (push/state.json) e manda le notifiche Web Push.
// La chiave privata VAPID sta SOLO nei "secrets" del repository (VAPID_PRIVATE), mai nei file.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import webpush from 'web-push';

const ROOT = process.cwd();
const APP_URL = process.env.APP_URL;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = (process.env.VAPID_PRIVATE || '').trim();
const STATE_FILE = path.join(ROOT, 'push', 'state.json');
const CAL_DIR = path.join(ROOT, 'cal');
const log = (...a) => console.log('[motore]', ...a);

const PREF_DEFAULTS = { notifyChanges: true, notifyRep: true, notifyTomorrow: false };
const romeHour = () => Number(new Intl.DateTimeFormat('it-IT', { hour: '2-digit', hour12: false, timeZone: 'Europe/Rome' }).format(new Date()));
const dayLabel = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' }); };

async function readApp() {
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome' }); }
  catch (e) { log('Chrome di sistema non trovato, uso Chromium di Playwright'); browser = await chromium.launch(); }
  try {
    const ctx = await browser.newContext({ timezoneId: 'Europe/Rome', locale: 'it-IT' });
    const page = await ctx.newPage();
    page.on('pageerror', e => log('errore nella pagina:', e.message));
    await page.goto(APP_URL + (APP_URL.includes('?') ? '&' : '?') + 'server=1', { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => typeof serverReady === 'function' && serverReady(), null, { timeout: 120000, polling: 1000 });
    await page.waitForTimeout(8000);   // reperibilità, caselle personalizzate e impostazioni arrivano da ascoltatori separati
    const X = await page.evaluate(() => serverExport());
    return { X, removeSubs: ids => page.evaluate(ids => serverRemoveSubs(ids), ids), close: () => browser.close() };
  } catch (e) { await browser.close(); throw e; }
}

function writeCalendars(X) {
  fs.mkdirSync(CAL_DIR, { recursive: true });
  let changed = 0;
  const keep = new Set();
  for (const [slug, ics] of Object.entries(X.ics)) {
    if (!slug) continue;
    const f = path.join(CAL_DIR, slug + '.ics'); keep.add(slug + '.ics');
    const old = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    if (old !== ics) { fs.writeFileSync(f, ics); changed++; }
  }
  // chi non c'è più: il calendario resta ma vuoto (così il telefono non va in errore)
  for (const f of fs.readdirSync(CAL_DIR)) {
    if (!f.endsWith('.ics') || keep.has(f)) continue;
    const empty = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Turni 118 San Marino//IT\r\nEND:VCALENDAR\r\n';
    if (fs.readFileSync(path.join(CAL_DIR, f), 'utf8') !== empty) { fs.writeFileSync(path.join(CAL_DIR, f), empty); changed++; }
  }
  log(`calendari: ${Object.keys(X.ics).length}, aggiornati ${changed}`);
}

function buildMessages(X, old) {
  const out = [];   // { owner: 'NOME' | '*coord*', title, body, tag }
  const hour = romeHour();
  const sent = old.sent || {};
  const people = X.people;
  const prefsOf = orig => Object.assign({}, PREF_DEFAULTS, X.prefs[String(orig).toUpperCase()] || {});
  const labelOf = code => code.split('+').map(c => X.labels[c] || c).join(' + ');

  // 1. cambi ai turni (solo giorni già noti al giro precedente)
  if (old.schedule) {
    for (const p of people) {
      const prev = old.schedule[p.orig]; if (!prev) continue;
      const now = X.schedule[p.orig] || {};
      if (!prefsOf(p.orig).notifyChanges) continue;
      const days = Object.keys(now).filter(d => d >= X.today && d in prev && prev[d] !== now[d]).sort();
      const added = days.filter(d => !prev[d]), diffs = days.filter(d => prev[d]);
      if (added.length > 4) {   // mese nuovo pubblicato: un avviso solo
        out.push({ owner: p.orig, title: 'Nuovi turni', body: `Inseriti ${added.length} giorni, dal ${dayLabel(added[0])} al ${dayLabel(added[added.length - 1])}.`, tag: 'nuovi' });
      } else diffs.push(...added);
      if (!diffs.length) continue;
      diffs.sort();
      const lines = diffs.slice(0, 4).map(d => `${dayLabel(d)}: ${prev[d] ? labelOf(prev[d]) : 'vuoto'} → ${now[d] ? labelOf(now[d]) : 'vuoto'}`);
      if (diffs.length > 4) lines.push(`e altri ${diffs.length - 4} giorni`);
      out.push({ owner: p.orig, title: diffs.length === 1 ? 'Turno cambiato' : `${diffs.length} turni cambiati`, body: lines.join('\n'), tag: 'cambi' });
    }
  }
  // 2. promemoria del giorno dopo (dalle 12 in poi, una volta sola)
  if (hour >= 12) {
    for (const p of people) {
      const pr = prefsOf(p.orig);
      const kRep = `rep|${X.tomorrow}|${p.orig}`, kTom = `tom|${X.tomorrow}|${p.orig}`;
      if (pr.notifyRep && X.repTomorrow[p.orig] && !sent[kRep]) {
        out.push({ owner: p.orig, title: 'Reperibilità domani', body: 'Sei ' + X.repTomorrow[p.orig] + '.', tag: 'rep', key: kRep });
      }
      const code = (X.schedule[p.orig] || {})[X.tomorrow];
      if (pr.notifyTomorrow && code && !sent[kTom]) {
        out.push({ owner: p.orig, title: 'Domani', body: labelOf(code), tag: 'domani', key: kTom });
      }
    }
  }
  // 3. nuove richieste → coordinatori
  if (old.reqIds) {
    const seen = new Set(old.reqIds);
    for (const r of X.requests.filter(r => !seen.has(r.id)).reverse()) {
      const when = r.dateFrom ? ' dal ' + dayLabel(r.dateFrom) + (r.dateTo && r.dateTo !== r.dateFrom ? ' al ' + dayLabel(r.dateTo) : '') : '';
      // cessione di reperibilità: è già nel calendario, al coordinatore arriva solo come informazione
      if (r.kind === 'copertura_reperibilita' && r.auto !== false) out.push({ owner: '*coord*', title: 'Cessione di reperibilità (già inserita)', body: `${r.name || '—'} cede a ${r.swapWith || '—'}${r.dateFrom ? ' il ' + dayLabel(r.dateFrom) : ''}${r.timeSlot ? ' (' + r.timeSlot + ')' : ''}. Inserita in automatico: non serve fare nulla.`, tag: 'req-' + r.id });
      else out.push({ owner: '*coord*', title: 'Nuova richiesta dal portale', body: `${r.name || '—'}: ${r.type}${r.swapWith ? ' con ' + r.swapWith : ''}${when}`, tag: 'req-' + r.id });
    }
  }
  return out;
}

async function sendAll(X, messages, state) {
  const subs = Object.entries(X.subs || {});
  if (!messages.length) { log('nessuna notifica da mandare'); return []; }
  if (!VAPID_PRIVATE) { log(`${messages.length} notifiche pronte ma manca il secret VAPID_PRIVATE: non mandate`); state.problem = 'Manca il secret VAPID_PRIVATE: le notifiche non partono.'; return []; }
  // una chiave sbagliata non deve fermare tutto: i calendari si salvano lo stesso e il problema resta scritto
  // in push/state.json (lo mostra il pannello admin dell'app)
  try { webpush.setVapidDetails('mailto:centrale118rsm-code@users.noreply.github.com', VAPID_PUBLIC, VAPID_PRIVATE); }
  catch (e) { log('CHIAVE VAPID_PRIVATE NON VALIDA:', e.message, '- nel secret va solo la chiave privata, senza spazi ne scritte'); state.problem = 'Chiave VAPID_PRIVATE non valida (' + e.message + '): le notifiche non partono.'; return []; }
  const coords = new Set(X.coordinators || []);
  const matches = (owner, p) => { const o = String(owner || '').toUpperCase(); return o && (o === String(p).toUpperCase() || X.people.some(x => x.orig === p && x.name.toUpperCase() === o)); };
  const dead = new Set();
  let ok = 0;
  for (const m of messages) {
    const targets = subs.filter(([, s]) => m.owner === '*coord*' ? coords.has(String(s.owner || '').toUpperCase()) : matches(s.owner, m.owner));
    for (const [id, s] of targets) {
      if (dead.has(id)) continue;
      try {
        await webpush.sendNotification(s.sub, JSON.stringify({ title: m.title, body: m.body, tag: m.tag, url: X.url }), { TTL: 6 * 3600, urgency: 'normal' });
        ok++;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.add(id);
        else log('invio non riuscito', id, e.statusCode || '', e.body || e.message);
      }
    }
    if (m.key) state.sent[m.key] = Date.now();
  }
  log(`notifiche: ${messages.length} messaggi, ${ok} consegnate, ${dead.size} telefoni da togliere`);
  return [...dead];
}

async function main() {
  if (!APP_URL || !VAPID_PUBLIC) throw new Error('APP_URL e VAPID_PUBLIC sono obbligatori');
  const old = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const app = await readApp();
  try {
    const { X } = app;
    if (!X || !X.people || X.people.length < 3) throw new Error('dati incompleti: non tocco niente');
    log(`${X.team}: ${X.people.length} persone, oggi ${X.today}`);
    writeCalendars(X);
    const state = { schedule: X.schedule, reqIds: X.requests.map(r => r.id), sent: {} };
    const limit = Date.now() - 4 * 86400000;
    Object.entries(old.sent || {}).forEach(([k, t]) => { if (t > limit) state.sent[k] = t; });
    let dead = [];
    try { dead = await sendAll(X, buildMessages(X, old), state); }
    catch (e) { log('invio delle notifiche non riuscito:', e.message); state.problem = 'Invio delle notifiche non riuscito: ' + e.message; }
    if (dead.length) await app.removeSubs(dead);
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const json = JSON.stringify(state, null, 1);
    if (!fs.existsSync(STATE_FILE) || fs.readFileSync(STATE_FILE, 'utf8') !== json) fs.writeFileSync(STATE_FILE, json);
  } finally { await app.close(); }
}

main().catch(e => { console.error('[motore] errore:', e); process.exit(1); });
