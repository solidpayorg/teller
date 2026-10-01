// The teller page: an account (sign in with a Nostr extension or a key kept here) sees its balance, its deposit address and
// sends signed requests; the operator (its secret kept here) creates and publishes the ledger, scans deposits on the
// chain, applies transfers, pays withdrawals by hand. The rules are lib/teller.mjs; this file is wiring only.
// Pinned by commit from the CDN: the engine (bitcoin-desktop/schema) and the sidestr library. Chain data: mempool.guide.
import * as T from './lib/teller.mjs';
const SCHEMA = 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@b8cbf6337c7450fe14ddc5bce00c7280059aab5d';
const SPEC = 'https://cdn.jsdelivr.net/gh/sidestr/spec@e8deb63161c7459ed39c01d2ca9fda3d860b65b6/siding/lib';
const ESPLORA = 'https://mempool.guide/testnet4/api';
const RELAYS = ['wss://nos.lol', 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nostr.oxtr.dev'];
const REEF = 'https://bitcoin-blake.github.io/reef/';
const q = new URLSearchParams(location.search); const DRY = q.get('dry') === '1'; // ?dry=1: publish and broadcast nothing
const $ = (id) => document.getElementById(id);
const LS = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (s) => (s ? String(s).slice(0, 12) + '…' + String(s).slice(-6) : '');
const fmt = (n) => Number(n).toLocaleString('en-US') + ' sat';
const notice = (text, cls = 'info') => { const n = $('notice'); n.innerHTML = `<div class="card n-${cls}">${esc(text)}</div>`; };

// ---- the libraries
const [hash, secp, { verifyNostrEvent }, { makeSigner }, { makeKeys }, txsign, address, relay] = await Promise.all([
  import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${SCHEMA}/codec/nostr.js`), import(`${SPEC}/schnorr.mjs`), import(`${SPEC}/keys.mjs`), import(`${SPEC}/txsign.mjs`), import(`${SPEC}/address.mjs`), import(`${SPEC}/relay.mjs`),
]).catch((e) => { notice(`The libraries could not be loaded from the CDN (${e.message}). Nothing works without them: try again later.`, 'bad'); throw e; });
const signer = makeSigner({ hash, secp }), keys = makeKeys({ hash, secp }), events = relay.makeEvents({ signer, hash });
const deps = { hash, secp, keys, address, signer, events, txsign };
let kernel = null; // the chain's rules, loaded only when the operator pays out
async function loadKernel() {
  if (kernel) return kernel;
  const [{ createKernel }, { knotsBlake2b }] = await Promise.all([import(`${SCHEMA}/codec/kernel.js`), import(`${SCHEMA}/codec/overlays/knots-blake2b.js`)]);
  const j = async (p) => { const r = await fetch(`${SCHEMA}/${p}`); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };
  const [core, proof, script, chain, validate, ov] = await Promise.all(['core', 'proof', 'script', 'chain', 'validate', 'overlays/knots-blake2b'].map((f) => j(`schema/${f}.jsonld`)));
  kernel = createKernel({ core, proof, script, chain, validate, network: 'btc:testnet4-blake2b', overlays: [knotsBlake2b(ov)] }); return kernel;
}

// ---- relays: the ledger (addressable by its hash) and the requests (by kind, the ledger tag checked on receipt)
function fetchLedger(hashHex, { timeout = 7000 } = {}) {
  return new Promise((resolve) => {
    let best = null, open = RELAYS.length; const sockets = []; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); for (const w of sockets) { try { w.close(); } catch {} } resolve(best); };
    const t = setTimeout(finish, timeout);
    for (const url of RELAYS) {
      let ws; try { ws = new WebSocket(url); } catch { if (--open <= 0) finish(); continue; } sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'ledger', { kinds: [T.LEDGER_KIND], '#d': [hashHex], limit: 5 }]));
      ws.onmessage = (m) => { let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]?.kind === T.LEDGER_KIND) { const ev = msg[2]; let ok = false; try { ok = verifyNostrEvent(ev); } catch {} if (!ok) return; let doc; try { doc = JSON.parse(ev.content); } catch { return; }
          try { T.checkLedger(deps, doc); } catch { return; } if (doc.hash !== hashHex || T.xOf(doc.genesis.operator) !== ev.pubkey) return; // the operator's own word only
          if (!best || ev.created_at > best.event.created_at) best = { ledger: doc, event: ev }; }
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { try { ws.close(); } catch {} if (--open <= 0) finish(); } };
      ws.onerror = () => {}; ws.onclose = () => { if (--open <= 0) finish(); };
    }
  });
}
const ledgerEvent = (key, ledger) => events.signEvent(key, { kind: T.LEDGER_KIND, tags: [['d', ledger.hash], ['t', 'webledgers'], ['name', ledger.name], ['alt', `Web Ledger ${ledger.name} (${ledger.defaultCurrency})`]], content: JSON.stringify(ledger) });
async function publishEvent(ev) { if (DRY) return { dry: 'not published (?dry=1)' }; return relay.publish({ relays: RELAYS, event: ev }); }
const okCount = (res) => Object.values(res).filter((r) => r === 'ok').length;

// ---- the chain, through the explorer
const api = async (p, init) => { const r = await fetch(ESPLORA + p, init); if (!r.ok) throw new Error(`${p}: ${r.status} ${(await r.text()).slice(0, 120)}`); return r; };
const tipHeight = async () => Number(await (await api('/blocks/tip/height')).text());
const utxosOf = async (addr) => (await api(`/address/${addr}/utxo`)).json();
const broadcast = async (hex) => { if (DRY) return 'dry-run-no-txid'; return (await api('/tx', { method: 'POST', body: hex })).text(); };

// ---- state
let ledger = null, ledgerEv = null; // the ledger shown
let account = null; // { did, x, sign: async (unsigned) => event }
let operator = null; // { key, point, did }
const render = () => { renderLedger(); renderAccount(); renderOperator(); };

// ---- the ledger section
function renderLedger() {
  if (!ledger) { $('linfo').textContent = 'No ledger loaded. A ledger is published by its operator as a Nostr event; its hash is the identity.'; $('ltable').innerHTML = ''; return; }
  const when = ledgerEv ? new Date(ledgerEv.created_at * 1000).toLocaleString() : 'not published yet';
  $('linfo').innerHTML = `<b>${esc(ledger.name)}</b> · ${esc(ledger.defaultCurrency)} · operator <span class="mono">${esc(short(ledger.genesis.operator))}</span> · ${ledger.genesis.confirmations} confirmation${ledger.genesis.confirmations === 1 ? '' : 's'} · ${ledger.entries.length} account${ledger.entries.length === 1 ? '' : 's'}, ${esc(fmt(T.total(ledger)))} in all · published ${esc(when)}${DRY ? ' · <span class="warn">dry run</span>' : ''}`;
  $('ltable').innerHTML = ledger.entries.length ? `<table><thead><tr><th>Account</th><th class="n">Balance</th></tr></thead><tbody>${ledger.entries.map((e) => `<tr><td class="mono wrap">${esc(e.url)}</td><td class="n">${esc(fmt(e.amount))}</td></tr>`).join('')}</tbody></table>` : '<div class="tiny mut">No balances yet.</div>';
}
async function loadLedger(h) {
  h = String(h || '').trim().toLowerCase(); if (!/^[0-9a-f]{64}$/.test(h)) return notice('A ledger hash is 64 hex characters.', 'bad');
  notice('Asking the relays for the ledger…');
  const mine = operator && JSON.parse(LS.get('teller:ledger:' + h) || 'null');
  const found = await fetchLedger(h);
  if (!found && !mine) return notice('No relay has a ledger with that hash (published by its operator).', 'bad');
  // the newest word wins: the operator's own copy here, or the published one
  ledger = found && (!mine || found.ledger.updated >= mine.updated) ? found.ledger : mine; ledgerEv = found?.event ?? null;
  LS.set('teller:last', h); history.replaceState(null, '', '?ledger=' + h + (DRY ? '&dry=1' : ''));
  notice(`Ledger ${ledger.name} loaded${found ? ' from the relays' : ' from this browser (not yet published)'}.`, 'ok'); render();
}
$('lload').onclick = () => loadLedger($('lhash').value);

// ---- the account section
function renderAccount() {
  const on = !!account; $('acct').hidden = !on; $('signin').hidden = on; if (!on) return;
  $('adid').textContent = account.did;
  if (!ledger) { $('abal').textContent = 'load a ledger first'; $('aaddr').textContent = '…'; $('apay').hidden = true; return; }
  $('abal').textContent = fmt(T.balance(ledger, account.did));
  const d = T.depositAddress(deps, { operatorPoint: ledger.genesis.operator, ledgerHash: ledger.hash, account: account.did });
  $('aaddr').textContent = d.address;
  $('apay').href = REEF + '?pay=' + encodeURIComponent(`bitcoin:${d.address}?label=${encodeURIComponent(ledger.name)}`); $('apay').hidden = false;
}
async function signIn(key) {
  if (key) { if (!/^[0-9a-f]{64}$/i.test(key)) return notice('A key is 64 hex characters.', 'bad'); key = key.toLowerCase(); const point = keys.publicKey(key); account = { did: keys.did(point), x: keys.xOnly(point), sign: async (u) => events.signEvent(key, u) }; LS.set('teller:key', key); }
  else if (window.nostr) { try { const x = (await window.nostr.getPublicKey()).toLowerCase(); account = { did: 'did:nostr:' + x, x, sign: async (u) => window.nostr.signEvent({ ...u, created_at: Math.floor(Date.now() / 1000) }) }; LS.set('teller:nip07', '1'); } catch (e) { return notice(`The extension did not sign in: ${e.message}`, 'bad'); } }
  else return notice('No Nostr extension found in this browser: make or paste a key instead.', 'bad');
  render();
}
$('nip07').onclick = () => signIn(null);
$('keyuse').onclick = () => signIn($('keyin').value.trim());
$('keynew').onclick = () => { const k = signer.randomKey(); $('keyin').value = k; signIn(k); notice('A new key was made and kept in this browser. Back it up: it is the account.', 'ok'); };
$('signout').onclick = () => { account = null; LS.del('teller:key'); LS.del('teller:nip07'); render(); };
$('acopy').onclick = async () => { try { await navigator.clipboard.writeText($('aaddr').textContent); notice('Deposit address copied.', 'ok'); } catch { notice('The browser did not allow copying: select the address and copy it.', 'bad'); } };
async function sendRequest(req) {
  if (!ledger) return notice('Load a ledger first.', 'bad'); if (!account) return notice('Sign in first.', 'bad');
  let ev; try { ev = await account.sign({ kind: T.REQUEST_KIND, tags: T.requestTags({ ledgerHash: ledger.hash, ...req }), content: '' }); } catch (e) { return notice(e.message, 'bad'); }
  const res = await publishEvent(ev); const n = DRY ? 0 : okCount(res);
  $('aout').textContent = DRY ? `Request ${req.op} signed (dry run: not published): ${ev.id.slice(0, 16)}…` : n ? `Request ${req.op} published to ${n} relay(s): ${ev.id.slice(0, 16)}… The operator applies it on its next scan.` : `No relay accepted the request: ${JSON.stringify(res)}`;
  notice($('aout').textContent, n || DRY ? 'ok' : 'bad');
}
$('ajoin').onclick = () => sendRequest({ op: 'join' });
$('wgo').onclick = () => { const to = $('wto').value.trim(); if (!address.decodeAddress(to)) return notice('That is not a valid address.', 'bad'); sendRequest({ op: 'withdraw', amount: $('wamt').value.trim(), to }); };
$('tgo').onclick = () => sendRequest({ op: 'transfer', amount: $('tamt').value.trim(), to: $('tto').value.trim() });

// ---- the operator section
const saveLedger = () => { if (ledger) LS.set('teller:ledger:' + ledger.hash, JSON.stringify(ledger)); };
function renderOperator() {
  if (!operator) { $('opinfo').textContent = 'No operator key here.'; $('opledger').hidden = true; return; }
  $('opinfo').innerHTML = `Operator <span class="mono">${esc(operator.did)}</span>${ledger ? (ledger.genesis.operator === operator.did ? ' · <span class="ok">this ledger is yours</span>' : ' · <span class="warn">the loaded ledger has another operator</span>') : ''}`;
  $('opledger').hidden = !(ledger && ledger.genesis.operator === operator.did);
}
function useOperator(key) { if (!/^[0-9a-f]{64}$/i.test(key)) return notice('A key is 64 hex characters.', 'bad'); key = key.toLowerCase(); const point = keys.publicKey(key); operator = { key, point, did: keys.did(point) }; LS.set('teller:operator', key); render(); }
$('opuse').onclick = () => useOperator($('opkey').value.trim());
$('opnew').onclick = () => { const k = signer.randomKey(); $('opkey').value = k; useOperator(k); notice('An operator key was made and kept in this browser. Back it up: every deposit is paid to addresses derived from it.', 'ok'); };
$('opcreate').onclick = async () => {
  if (!operator) return notice('Use or make an operator key first.', 'bad');
  let L; try { L = T.newLedger(deps, { operator: operator.did, name: $('opname').value.trim(), confirmations: Number($('opconf').value) || 1 }); } catch (e) { return notice(e.message, 'bad'); }
  ledger = L; ledgerEv = null; saveLedger(); $('lhash').value = L.hash; const res = await publishEvent(ledgerEvent(operator.key, L));
  LS.set('teller:last', L.hash); history.replaceState(null, '', '?ledger=' + L.hash + (DRY ? '&dry=1' : ''));
  notice(DRY ? `Ledger ${L.name} created (dry run: not published). Hash ${L.hash}` : `Ledger ${L.name} created and published to ${okCount(res)} relay(s). Its hash is its identity: ${L.hash}`, 'ok'); render();
};
$('oppublish').onclick = async () => { if (!operator || !ledger) return; const res = await publishEvent(ledgerEvent(operator.key, ledger)); notice(DRY ? 'Dry run: not published.' : `Ledger published to ${okCount(res)} relay(s).`, 'ok'); };
let requests = new Map(), coins = []; // requests by id; the deposits held, as coins for a payout
async function scan() {
  if (!operator || !ledger || ledger.genesis.operator !== operator.did) return;
  $('opstat').textContent = 'scanning…';
  // requests: every kind-3700 event of the last 30 days on the relays, this ledger's by tag, verified, each once by id
  const sub = relay.subscribe({ relays: RELAYS, chainId: ledger.hash, verify: verifyNostrEvent, since: 30 * 86400, kind: T.REQUEST_KIND, tag: 'ledger', onEvent: (ev) => { try { const r = T.parseRequest(ev, { verify: verifyNostrEvent, ledgerHash: ledger.hash }); if (!requests.has(r.id)) requests.set(r.id, r); } catch {} } });
  await new Promise((r) => setTimeout(r, 6000)); sub.close();
  // transfers apply themselves (the payer signed); joins extend the watch list; withdrawals wait for the operator
  const joined = [...requests.values()].filter((r) => r.op === 'join').map((r) => r.account);
  for (const r of [...requests.values()].filter((r) => r.op === 'transfer' && !ledger.applied.includes(r.id))) { try { T.transfer(ledger, { id: r.id, from: r.account, to: r.to, amount: r.amount }, r.created_at); } catch {} }
  // deposits: every watched address asked of the explorer; confirmed outputs credited once; all unspent ones are the coins
  let tip = 0; try { tip = await tipHeight(); } catch (e) { $('opstat').textContent = `the explorer did not answer: ${e.message}`; return; }
  const watch = T.watchList(deps, ledger, operator.point, [...joined, operator.did]); coins = []; let credited = 0;
  for (const d of watch) {
    let us = []; try { us = await utxosOf(d.address); } catch (e) { $('opstat').textContent = `${short(d.address)}: ${e.message}`; continue; }
    for (const u of us) { const deep = u.status?.confirmed && tip - u.status.block_height + 1 >= ledger.genesis.confirmations; if (deep) { coins.push({ txid: u.txid, vout: u.vout, value: u.value, script: d.script, tweak: d.tweak, address: d.address }); if (d.account !== operator.did && T.credit(ledger, { account: d.account, txid: u.txid, vout: u.vout, value: u.value, height: u.status.block_height }).applied) credited++; } }
  }
  saveLedger(); $('opstat').textContent = `tip ${tip.toLocaleString('en-US')} · ${watch.length} address(es) watched · ${credited} new deposit(s) credited · ${coins.length} unspent output(s) held (${fmt(coins.reduce((a, c) => a + c.value, 0))}) · ${requests.size} request(s)`;
  $('opcoins').textContent = coins.length ? 'Held: ' + coins.map((c) => `${c.txid.slice(0, 8)}…:${c.vout} ${fmt(c.value)}`).join(' · ') : 'No confirmed deposits held.';
  renderRequests(); render();
}
function renderRequests() {
  const rows = [...requests.values()].sort((a, b) => b.created_at - a.created_at).map((r) => { const done = ledger.applied.includes(r.id); const what = r.op === 'join' ? 'join' : `${r.op} ${fmt(r.amount)} → ${r.op === 'transfer' ? short(r.to) : r.to}`;
    return `<tr><td class="tiny">${esc(new Date(r.created_at * 1000).toLocaleString())}</td><td class="mono wrap">${esc(short(r.account))}</td><td class="wrap">${esc(what)}</td><td>${r.op === 'withdraw' ? (done ? '<span class="ok">paid</span>' : `<button type="button" data-pay="${esc(r.id)}">Pay it out</button>`) : r.op === 'transfer' ? (done ? '<span class="ok">applied</span>' : '<span class="warn">not applied (balance?)</span>') : 'watched'}</td></tr>`; });
  $('opreqs').innerHTML = rows.length ? `<table><thead><tr><th>When</th><th>Account</th><th>Request</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` : '<div class="tiny mut">No requests yet.</div>';
  for (const b of $('opreqs').querySelectorAll('button[data-pay]')) b.onclick = () => payout(requests.get(b.dataset.pay));
}
async function payout(r) {
  if (!r || r.op !== 'withdraw' || ledger.applied.includes(r.id)) return;
  if (T.balance(ledger, r.account) < r.amount) return notice(`${short(r.account)} has ${fmt(T.balance(ledger, r.account))}, not ${fmt(r.amount)}: not paid.`, 'bad');
  const dec = address.decodeAddress(r.to); if (!dec) return notice('The request names an address that does not decode: not paid.', 'bad');
  if (!confirm(`Pay ${fmt(r.amount)} to ${r.to} for ${r.account}? The ledger is debited when the payment is broadcast.`)) return;
  try {
    const k = await loadKernel(); const change = T.depositAddress(deps, { operatorPoint: operator.point, ledgerHash: ledger.hash, account: operator.did });
    const p = T.planPayout({ coins, amount: r.amount, rate: 1, toScript: dec.script, changeScript: change.script });
    const s = T.signPayout({ ...deps, k }, p, operator.key); const txid = await broadcast(s.hex);
    T.debit(ledger, { id: r.id, account: r.account, amount: r.amount, to: r.to, txid }); saveLedger();
    const res = await publishEvent(ledgerEvent(operator.key, ledger));
    coins = coins.filter((c) => !p.picked.some((x) => x.txid === c.txid && x.vout === c.vout));
    notice(DRY ? `Dry run: a payout of ${fmt(r.amount)} was signed and checked (${s.txid.slice(0, 16)}…) but not broadcast; the ledger was debited here only.` : `Paid: ${txid}. The ledger is debited and published to ${okCount(res)} relay(s).`, 'ok'); renderRequests(); render();
  } catch (e) { notice(`Not paid: ${e.message}`, 'bad'); }
}
$('opscan').onclick = () => scan().catch((e) => notice(e.message, 'bad'));

// ---- start
{
  const k = LS.get('teller:key'); if (k) await signIn(k); else if (LS.get('teller:nip07') && window.nostr) await signIn(null);
  const ok = LS.get('teller:operator'); if (ok) useOperator(ok);
  const h = q.get('ledger') || LS.get('teller:last'); if (h) { $('lhash').value = h; await loadLedger(h); }
  render();
}
