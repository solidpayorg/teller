#!/usr/bin/env node
// The automatic operator: what the page's operator panel does by hand, every minute, unattended. It reads the
// ledger (its own copy on disk, or the operator's newest published copy), follows this ledger's requests on the
// relays, and on every tick: applies transfers, notes joins, credits confirmed deposits seen through the explorer,
// pays withdrawals under two caps (per payout, per hour; the rest wait with a reason, for a hand on the page), and
// publishes the ledger when anything changed. The operator's secret is read from a file, never the command line.
// A payout is written to disk before it is broadcast and finished after, so a crash between the two re-broadcasts
// the same transaction rather than signing a second one.
//   node bin/operator.mjs --key-file <path> --ledger <hash> --dir <state dir> [--every 60] [--max-payout 100000]
//     [--max-hour 500000] [--rate 1] [--relay wss://…,…] [--explorer https://mempool.guide/testnet4/api] [--once] [--dry]
//   env SCHEMA, BLAKETESTNODE, SIDESTR_LIB: the checkouts (defaults under ~), as for the tests
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const H = (p) => p.replace(/^~/, os.homedir());
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] == null ? true : all[i + 1]] : null).filter(Boolean));
const need = (k) => { if (!args[k] || args[k] === true) { console.error(`--${k} is needed`); process.exit(2); } return args[k]; };
const KEY_FILE = need('key-file'), LEDGER = need('ledger'), DIR = need('dir');
const EVERY = Number(args.every ?? 60), MAX_PAYOUT = Number(args['max-payout'] ?? 100000), MAX_HOUR = Number(args['max-hour'] ?? 500000), RATE = Number(args.rate ?? 1);
const RELAYS = String(args.relay ?? 'wss://nos.lol,wss://relay.damus.io,wss://relay.primal.net,wss://nostr.oxtr.dev').split(',');
const EXPLORER = args.explorer ?? 'https://mempool.guide/testnet4/api'; const ONCE = !!args.once, DRY = !!args.dry;
if (!/^[0-9a-f]{64}$/.test(LEDGER)) { console.error('--ledger is the 64-hex ledger hash'); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---- the libraries, as the tests load them
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const here = path.dirname(new URL(import.meta.url).pathname);
const [{ loadEngine }, hash, secp, { makeSigner }, { makeKeys }, txsign, address, relay, { verifyNostrEvent }, T, O] = await Promise.all([
  import(`${BTN}/lib/engine.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/keys.mjs`), import(`${LIB}/txsign.mjs`), import(`${LIB}/address.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/nostr.js`), import(`${here}/../lib/teller.mjs`), import(`${here}/../lib/operator.mjs`)]);
const signer = makeSigner({ hash, secp }), keys = makeKeys({ hash, secp }), events = relay.makeEvents({ signer, hash });
const deps = { hash, secp, keys, address, signer, events, txsign };
const k = await loadEngine('btc:testnet4-blake2b');

// ---- the operator
const key = fs.readFileSync(H(KEY_FILE), 'utf8').trim().toLowerCase(); if (!/^[0-9a-f]{64}$/.test(key)) { console.error('the key file holds 64 hex characters'); process.exit(2); }
const point = keys.publicKey(key), did = keys.did(point);
fs.mkdirSync(H(DIR), { recursive: true }); const file = (n) => path.join(H(DIR), n);
const readJson = (n, dflt) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return dflt; } };
const writeJson = (n, v) => { fs.writeFileSync(file(n) + '.tmp', JSON.stringify(v, null, 1)); fs.renameSync(file(n) + '.tmp', file(n)); };

// ---- the ledger: the newest of the copy on disk and the operator's own published copy
function fetchLedger(hashHex, { timeout = 7000 } = {}) {
  return new Promise((resolve) => {
    let best = null, open = RELAYS.length; const sockets = []; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); for (const w of sockets) { try { w.close(); } catch {} } resolve(best); };
    const t = setTimeout(finish, timeout);
    for (const url of RELAYS) {
      let ws; try { ws = new WebSocket(url); } catch { if (--open <= 0) finish(); continue; } sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'ledger', { kinds: [T.LEDGER_KIND], '#d': [hashHex], limit: 5 }]));
      ws.onmessage = (m) => { let msg; try { msg = JSON.parse(String(m.data)); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]?.kind === T.LEDGER_KIND) { const ev = msg[2]; let ok = false; try { ok = verifyNostrEvent(ev); } catch {} if (!ok) return; let doc; try { doc = JSON.parse(ev.content); } catch { return; }
          try { T.checkLedger(deps, doc); } catch { return; } if (doc.hash !== hashHex || T.xOf(doc.genesis.operator) !== ev.pubkey) return;
          if (!best || ev.created_at > best.event.created_at) best = { ledger: doc, event: ev }; }
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { try { ws.close(); } catch {} if (--open <= 0) finish(); } };
      ws.onerror = () => {}; ws.onclose = () => { if (--open <= 0) finish(); };
    }
  });
}
let ledger = readJson('ledger.json', null); if (ledger) { try { T.checkLedger(deps, ledger); if (ledger.hash !== LEDGER) ledger = null; } catch { ledger = null; } }
{ const found = await fetchLedger(LEDGER); if (found && (!ledger || (found.ledger.updated ?? 0) > (ledger.updated ?? 0))) { ledger = found.ledger; log('ledger from the relays, published', new Date(found.event.created_at * 1000).toISOString()); } else if (ledger) log('ledger from disk, updated', new Date((ledger.updated ?? 0) * 1000).toISOString()); }
if (!ledger) { console.error('no ledger: not on disk, not on the relays'); process.exit(1); }
if (ledger.genesis.operator !== did) { console.error(`the key is ${did}, the ledger's operator is ${ledger.genesis.operator}`); process.exit(1); }
log(`operator ${did} · ledger ${ledger.name} (${LEDGER.slice(0, 12)}…) · every ${EVERY}s · caps ${MAX_PAYOUT} sat per payout, ${MAX_HOUR} sat per hour · ${DRY ? 'DRY (nothing broadcast or published)' : 'live'}`);
const saveLedger = () => writeJson('ledger.json', ledger);
const joined = new Set(readJson('joined.json', [])); const saveJoined = () => writeJson('joined.json', [...joined]);

// ---- the requests: followed continuously, each verified and parsed once
const requests = new Map();
const sub = relay.subscribe({ relays: RELAYS, chainId: LEDGER, verify: verifyNostrEvent, since: 30 * 86400, kind: T.REQUEST_KIND, tag: 'ledger', onEvent: (ev) => { try { const r = T.parseRequest(ev, { verify: verifyNostrEvent, ledgerHash: LEDGER }); if (!requests.has(r.id)) requests.set(r.id, r); } catch {} } });

// ---- the chain, through the explorer
const api = async (p, init) => { const r = await fetch(EXPLORER + p, init); if (!r.ok) { let body = (await r.text()).slice(0, 300); try { const j = JSON.parse(body); body = j.error ?? body; } catch {} throw new Error(`${p}: ${r.status} ${body}`); } return r; };
const tipHeight = async () => Number(await (await api('/blocks/tip/height')).text());
const utxosOf = async (addr) => (await api(`/address/${addr}/utxo`)).json();
const txKnown = async (txid) => { try { await api(`/tx/${txid}`); return true; } catch { return false; } };
const broadcast = async (hex) => (await api('/tx', { method: 'POST', body: hex })).text();
const ledgerEvent = () => events.signEvent(key, { kind: T.LEDGER_KIND, tags: [['d', ledger.hash], ['t', 'webledgers'], ['name', ledger.name], ['alt', `Web Ledger ${ledger.name} (${ledger.defaultCurrency})`]], content: JSON.stringify(ledger) });
async function publishLedger() { if (DRY) return 'dry'; const res = await relay.publish({ relays: RELAYS, event: ledgerEvent() }); const n = Object.values(res).filter((r) => r === 'ok').length; if (!n) log('WARN no relay accepted the ledger', JSON.stringify(res)); return n; }

// a payout half done when the process last stopped: the same transaction again, never a second one
async function finishInflight() {
  const f = readJson('inflight.json', null); if (!f) return;
  if (ledger.applied.includes(f.id)) { fs.rmSync(file('inflight.json')); return; }
  const known = await txKnown(f.txid); let txid = f.txid;
  if (!known) { try { txid = await broadcast(f.hex); log('inflight payout re-broadcast', txid); } catch (e) { log('inflight payout could not be re-broadcast, left for a hand:', e.message); fs.rmSync(file('inflight.json')); return; } }
  else log('inflight payout found on the chain', txid);
  T.debit(ledger, { id: f.id, account: f.account, amount: f.amount, to: f.to, txid }); saveLedger(); fs.rmSync(file('inflight.json')); await publishLedger();
}
await finishInflight();

// ---- a tick
let coins = []; let ticks = 0;
async function tick() {
  ticks++; let changed = 0; const now = Math.floor(Date.now() / 1000);
  // transfers apply themselves (the payer signed); joins extend the watch list
  for (const r of requests.values()) {
    if (r.op === 'join' && !joined.has(r.account)) { joined.add(r.account); saveJoined(); log('join', r.account); }
    if (r.op === 'transfer' && !ledger.applied.includes(r.id)) { try { if (T.transfer(ledger, { id: r.id, from: r.account, to: r.to, amount: r.amount }, r.created_at).applied) changed++; } catch (e) { if (!r.refused) { r.refused = true; log('transfer refused', r.id.slice(0, 8), e.message); } } }
  }
  // deposits: every watched address, confirmed outputs credited once; all unspent confirmed ones are the coins
  let tip; try { tip = await tipHeight(); } catch (e) { log('explorer did not answer:', e.message); return; }
  const watch = T.watchList(deps, ledger, point, [...joined, did]); const fresh = [];
  for (const d of watch) {
    let us; try { us = await utxosOf(d.address); } catch (e) { log('explorer:', d.address.slice(0, 16), e.message); continue; }
    for (const u of us) { const deep = u.status?.confirmed && tip - u.status.block_height + 1 >= ledger.genesis.confirmations; if (!deep) continue;
      fresh.push({ txid: u.txid, vout: u.vout, value: u.value, script: d.script, tweak: d.tweak, address: d.address });
      if (d.account !== did && T.credit(ledger, { account: d.account, txid: u.txid, vout: u.vout, value: u.value, height: u.status.block_height }, now).applied) { changed++; log('credit', d.account.slice(0, 20), u.value, 'sat', u.txid.slice(0, 12)); } }
  }
  coins = fresh;
  // withdrawals: under the caps, oldest first; each one signed, broadcast, debited, in that order, with a note on disk across the broadcast
  const { pay, held } = O.withdrawalsToPay(ledger, [...requests.values()], { maxPayout: MAX_PAYOUT, maxHour: MAX_HOUR, now, decodes: (a) => !!address.decodeAddress(a) });
  for (const h of held) if (!h.request.held || h.request.held !== h.why) { h.request.held = h.why; log('withdrawal waits', h.request.id.slice(0, 8), h.request.amount, 'sat:', h.why); }
  for (const r of pay) {
    try {
      const change = T.depositAddress(deps, { operatorPoint: point, ledgerHash: ledger.hash, account: did });
      const p = T.planPayout({ coins, amount: r.amount, rate: RATE, toScript: address.decodeAddress(r.to).script, changeScript: change.script });
      const s = T.signPayout({ ...deps, k }, p, key);
      if (DRY) { log('DRY payout', r.amount, 'sat →', r.to, 'would be', s.txid, `(${s.vsize} vB, fee ${p.fee})`); continue; }
      writeJson('inflight.json', { id: r.id, account: r.account, amount: r.amount, to: r.to, txid: s.txid, hex: s.hex });
      const txid = await broadcast(s.hex);
      T.debit(ledger, { id: r.id, account: r.account, amount: r.amount, to: r.to, txid }, now); saveLedger(); fs.rmSync(file('inflight.json')); changed++;
      coins = coins.filter((c) => !p.picked.some((x) => x.txid === c.txid && x.vout === c.vout));
      log('paid', r.amount, 'sat →', r.to, 'for', r.account.slice(0, 20), txid);
    } catch (e) { if (fs.existsSync(file('inflight.json'))) fs.rmSync(file('inflight.json')); log('payout failed', r.id.slice(0, 8), r.amount, 'sat:', e.message); }
  }
  if (changed) { saveLedger(); const n = await publishLedger(); log(`ledger changed (${changed}) · published to ${n} relay(s)`); }
  writeJson('status.json', { at: now, tip, ticks, requests: requests.size, applied: ledger.applied.length, held: held.length, coins: coins.length, holding: coins.reduce((a, c) => a + c.value, 0), book: T.total(ledger), entries: ledger.entries.length, dry: DRY });
  if (ticks === 1 || changed) log(`tick ${ticks}: tip ${tip} · ${requests.size} requests · ${ledger.applied.length} applied · ${held.length} waiting · holding ${coins.reduce((a, c) => a + c.value, 0)} sat in ${coins.length} output(s) · book ${T.total(ledger)} sat`);
}
await new Promise((r) => setTimeout(r, 6000)); // the first relay round
await tick();
if (ONCE) { sub.close(); process.exit(0); }
const timer = setInterval(() => tick().catch((e) => log('tick failed:', e.message)), EVERY * 1000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { clearInterval(timer); sub.close(); log('stopped'); process.exit(0); });
