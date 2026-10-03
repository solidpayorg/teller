// A client for a teller's ledger, for anything that pays in, is paid, or watches: a page, a game, a tip jar. It reads the
// operator's newest published copy from the relays, keeps a local copy with the requests signed here applied at once
// (milliseconds, no round trip), publishes those requests in the background and keeps re-sending until a relay has
// each one, and answers where a request stands. Pure of the DOM: the page hands in storage (localStorage or any
// {get, set}) and, in tests, a fake network. The rules are lib/teller.mjs; nothing here adds a kind, a tag or a derivation.
//
//   const client = await openLedger(hash, { T, deps, relay, verifyNostrEvent, relays, storage });
//   client.balance(did); client.depositAddress(did).address; client.payLink(did);
//   const r = await client.request({ op: 'transfer', amount: 60, to: winner }, signer);   // applied locally at once, published apart
//   client.status(r.id)   // 'unpublished' | 'pending' | 'applied' | { state: 'paid', txid }
//   client.on(() => draw()); client.start({ every: 45 }); client.stop();
import * as T_ from './teller.mjs';

/** a signer from a secret key (events signed here) or a NIP-07 extension (window.nostr); either way `sign(unsigned) → event` */
export const signerFromKey = ({ events, keys }, key) => { const point = keys.publicKey(key); return { did: keys.did(point), sign: async (u) => events.signEvent(key, u) }; };
export const signerFromNip07 = async (nostr) => { const x = (await nostr.getPublicKey()).toLowerCase(); return { did: 'did:nostr:' + x, sign: async (u) => nostr.signEvent({ ...u, created_at: Math.floor(Date.now() / 1000) }) }; };

/** the operator's newest signed copy of the ledger from the relays, or null: { ledger, event } */
export function fetchLedger(hashHex, { T = T_, deps, verifyNostrEvent, relays, timeout = 7000 }) {
  return new Promise((resolve) => {
    let best = null, open = relays.length; const sockets = []; let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(t); for (const w of sockets) { try { w.close(); } catch {} } resolve(best); };
    const t = setTimeout(finish, timeout);
    for (const url of relays) {
      let ws; try { ws = new WebSocket(url); } catch { if (--open <= 0) finish(); continue; } sockets.push(ws);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', 'ledger', { kinds: [T.LEDGER_KIND], '#d': [hashHex], limit: 5 }]));
      ws.onmessage = (m) => { let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
        if (msg[0] === 'EVENT' && msg[2]?.kind === T.LEDGER_KIND) { const ev = msg[2]; let ok = false; try { ok = verifyNostrEvent(ev); } catch {} if (!ok) return; let doc; try { doc = JSON.parse(ev.content); } catch { return; }
          try { T.checkLedger(deps, doc); } catch { return; } if (doc.hash !== hashHex || T.xOf(doc.genesis.operator) !== ev.pubkey) return; // the operator's own word only
          if (!best || ev.created_at > best.event.created_at) best = { ledger: doc, event: ev }; }
        if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') { try { ws.close(); } catch {} if (--open <= 0) finish(); } };
      ws.onerror = () => {}; ws.onclose = () => { if (--open <= 0) finish(); };
    }
  });
}

/** the local copy: the published ledger with the transfers signed here and not yet in it applied (once each, by id); a transfer the published copy could not take is dropped */
export function reconcile(T, published, requests) {
  const led = JSON.parse(JSON.stringify(published));
  for (const r of requests) { if (r.op !== 'transfer' || led.applied.includes(r.id)) continue; try { T.transfer(led, { id: r.id, from: r.from, to: r.to, amount: r.amount }, r.created_at); } catch { r.dropped = true; } }
  return led;
}

/**
 * open a ledger by its hash. storage: {get(key), set(key, value)} of strings (localStorage fits); net: { fetchLedger(hash) → {ledger, event}|null,
 * publish(event, url) → 'ok' | reason } (the default uses the relays). Throws if no relay has the ledger, unless `published` is given.
 */
export async function openLedger(hash, { T = T_, deps, relay, verifyNostrEvent, relays = [], storage = null, net = null, reef = 'https://bitcoin-blake.github.io/reef/', published = null, verify = verifyNostrEvent } = {}) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('a ledger hash is 64 hex characters');
  net = net ?? { fetchLedger: (h) => fetchLedger(h, { T, deps, verifyNostrEvent, relays }), publish: (event, url) => relay.publish({ relays: [url], event }).then((res) => res[url]) };
  const key = 'teller:client:' + hash; const listeners = new Set();
  // storage is {get, set} or Web Storage ({getItem, setItem}: localStorage as it is); the page's first run passed localStorage and nothing was kept
  const store = storage && typeof storage.getItem === 'function' ? { get: (k) => storage.getItem(k), set: (k, v) => storage.setItem(k, v) } : storage;
  const load = () => { try { return JSON.parse(store?.get(key) || '[]'); } catch { return []; } };
  const requests = load(); // every request signed here: { id, op, from, to, amount, created_at, published, event }
  const save = () => { try { store?.set(key, JSON.stringify(requests)); } catch {} };
  const c = {
    hash, published, ledger: null, requests, relays, net,
    get pending() { return requests.filter((r) => !c.published?.applied.includes(r.id) && !r.dropped); },
    get unpublished() { return requests.filter((r) => !r.published && r.event); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    _changed() { c.ledger = c.published ? reconcile(T, c.published, requests) : null; for (const fn of listeners) { try { fn(c); } catch {} } },
    /** ask the relays again; the newest copy wins */
    async refresh() { const found = await net.fetchLedger(hash); if (found && (!c.published || found.event.created_at >= (c.published.updated_at ?? 0))) { c.published = { ...found.ledger, updated_at: found.event.created_at }; } c._changed(); return c.ledger; },
    balance: (did) => (c.ledger ? T.balance(c.ledger, did) : 0),
    depositAddress: (did, nonce = 0) => T.depositAddress(deps, { operatorPoint: c.published.genesis.operator, ledgerHash: hash, account: did, nonce }),
    payLink: (did, { label = c.published?.name ?? '' } = {}) => reef + '?pay=' + encodeURIComponent(`bitcoin:${c.depositAddress(did).address}?label=${encodeURIComponent(label)}`),
    /** sign a request (join, withdraw, transfer) with the signer; a transfer is applied to the local copy at once; publishing runs apart */
    async request(req, signer) {
      const ev = await signer.sign({ kind: T.REQUEST_KIND, tags: T.requestTags({ ledgerHash: hash, ...req }), content: '' });
      const r = T.parseRequest(ev, { verify, ledgerHash: hash });
      const rec = { id: r.id, op: r.op, from: r.account, to: r.to ?? null, amount: r.amount ?? null, created_at: r.created_at, published: false, event: ev };
      requests.push(rec); save(); c._changed(); c.publishPending(); return rec;
    },
    /** where a request signed here stands: unpublished (no relay has it yet), pending (sent, not yet in the published ledger), applied, or paid with its txid */
    status(id) {
      const r = requests.find((x) => x.id === id); const payout = (c.published?.payouts ?? []).find((p) => p.id === id);
      if (payout) return { state: 'paid', txid: payout.txid, at: payout.at }; if (c.published?.applied.includes(id)) return { state: 'applied' };
      if (r?.dropped) return { state: 'dropped' }; return { state: r && !r.published ? 'unpublished' : 'pending' };
    },
    _publishing: false,
    /** every unpublished request at once, each relay on its own; the first OK marks it published; a slow relay holds nothing else up */
    async publishPending() {
      if (c._publishing) return; c._publishing = true;
      try { await Promise.all(c.unpublished.map((r) => Promise.all(relays.map((url) => net.publish(r.event, url).then((res) => { if (res === 'ok' && !r.published) { r.published = true; save(); c._changed(); } }).catch(() => {}))))); }
      finally { c._publishing = false; }
    },
    _timers: [],
    /** refresh and re-send on a clock */
    start({ every = 45, resend = 60 } = {}) { c.stop(); c._timers = [setInterval(() => c.refresh().catch(() => {}), every * 1000), setInterval(() => c.publishPending(), resend * 1000)]; c.publishPending(); return c; },
    stop() { for (const t of c._timers) clearInterval(t); c._timers = []; },
  };
  if (!c.published) { await c.refresh(); if (!c.published) throw new Error('no relay has a ledger with that hash (published by its operator)'); } else c._changed();
  return c;
}
