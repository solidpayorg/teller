// lib/client.mjs with a fake network: the local copy applies a transfer the moment it is signed, requests are published
// in the background and re-sent until a relay takes them, a reload loses nothing, and status says where each stands.
import os from 'node:os';
const H = (p) => p.replace(/^~/, os.homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const [hash, secp, { makeSigner }, { makeKeys }, address, { makeEvents }, { verifyNostrEvent }, T, C] = await Promise.all([
  import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/keys.mjs`), import(`${LIB}/address.mjs`), import(`${LIB}/relay.mjs`), import(`${SCHEMA}/codec/nostr.js`), import('../lib/teller.mjs'), import('../lib/client.mjs')]);
const signer = makeSigner({ hash, secp }), keys = makeKeys({ hash, secp }), events = makeEvents({ signer, hash }); const deps = { hash, secp, keys, address, signer, events };
let ok = 0, bad = 0;
const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// an operator, a ledger with two funded accounts, a fake network: the published copy and what each relay answers
const opKey = signer.randomKey(), opDid = keys.did(keys.publicKey(opKey)); const alice = C.signerFromKey(deps, signer.randomKey()), bob = C.signerFromKey(deps, signer.randomKey());
const L = T.newLedger(deps, { operator: opDid, name: 'Club', created: 1790900000 }); T.credit(L, { account: alice.did, txid: 'aa'.repeat(32), vout: 0, value: 5000 }, 1); T.credit(L, { account: bob.did, txid: 'bb'.repeat(32), vout: 0, value: 1000 }, 1);
const publishedEvent = (led, at) => ({ ledger: JSON.parse(JSON.stringify(led)), event: { created_at: at } });
const relays = ['wss://a', 'wss://b', 'wss://c']; const answers = { 'wss://a': 'ok', 'wss://b': 'timeout', 'wss://c': 'ok' }; const sent = [];
let served = publishedEvent(L, 100);
const net = { fetchLedger: async () => served, publish: async (ev, url) => { sent.push([url, ev.id]); await sleep(5); return answers[url]; } };
const storage = new Map(); const store = { get: (k) => storage.get(k) ?? null, set: (k, v) => storage.set(k, v) };
const open = () => C.openLedger(L.hash, { T, deps, relays, storage: store, net, verifyNostrEvent });

const c = await open();
t('opens from the published copy: balances and deposit addresses read without a signer', c.balance(alice.did) === 5000 && c.depositAddress(alice.did).address.startsWith('tb1p') && c.depositAddress(alice.did).address === T.depositAddress(deps, { operatorPoint: opDid, ledgerHash: L.hash, account: alice.did }).address);
t('the pay link is a Reef bitcoin: request for the deposit address', decodeURIComponent(c.payLink(alice.did)).includes('bitcoin:' + c.depositAddress(alice.did).address) && c.payLink(alice.did).includes('Club'));
let changes = 0; c.on(() => changes++);
const r = await c.request({ op: 'transfer', amount: 60, to: bob.did }, alice);
t('a transfer is applied to the local copy the moment it is signed; the published copy is untouched', c.balance(alice.did) === 4940 && c.balance(bob.did) === 1060 && T.balance(c.published, alice.did) === 5000 && r.op === 'transfer' && r.from === alice.did && changes >= 1);
t('status right after signing: unpublished (no relay has answered yet)', c.status(r.id).state === 'unpublished');
await sleep(40);
t('published once the first relay says OK; the slow relay holds nothing up; every relay was tried', c.status(r.id).state === 'pending' && c.unpublished.length === 0 && sent.filter((s) => s[1] === r.event.id).length === 3);
t('a request is also readable as pending: sent, not yet in the published ledger', c.pending.length === 1 && c.pending[0].id === r.id);
// a reload: the requests signed here come back from storage and the local copy is rebuilt the same
const c2 = await open();
t('after a reload the local copy is rebuilt from storage: same balances, same pending', c2.balance(alice.did) === 4940 && c2.pending.length === 1 && c2.status(r.id).state === 'pending');
// the operator applies it and publishes: pending is checked off, nothing applied twice
T.transfer(L, { id: r.id, from: alice.did, to: bob.did, amount: 60 }, r.created_at); served = publishedEvent(L, 200); await c2.refresh();
t('once the operator publishes it: applied, dropped from pending, balances unchanged (not applied twice)', c2.status(r.id).state === 'applied' && c2.pending.length === 0 && c2.balance(alice.did) === 4940);
// an unpublished request survives a reload and is re-sent
answers['wss://a'] = 'timeout'; answers['wss://c'] = 'rejected';
const r2 = await c2.request({ op: 'transfer', amount: 10, to: bob.did }, alice); await sleep(40);
t('when no relay takes a request it stays unpublished (applied locally all the same)', c2.status(r2.id).state === 'unpublished' && c2.balance(alice.did) === 4930);
answers['wss://a'] = 'ok'; const c3 = await open(); await c3.publishPending(); await sleep(40);
t('a reload re-sends it; once a relay takes it, it is pending', c3.status(r2.id).state === 'pending' && c3.balance(alice.did) === 4930);
// a withdrawal: not applied locally (the operator debits when it pays), paid once the published copy shows the payout
const w = await c3.request({ op: 'withdraw', amount: 1000, to: 'tb1p' + 'q'.repeat(58) }, alice); await sleep(40);
t('a withdrawal is not applied locally; it is pending until the operator pays', c3.balance(alice.did) === 4930 && c3.status(w.id).state === 'pending');
T.debit(L, { id: w.id, account: alice.did, amount: 1000, to: w.to, txid: 'cd'.repeat(32) }, 300); served = publishedEvent(L, 300); await c3.refresh();
t('paid, with the txid, once the published ledger carries the payout', c3.status(w.id).state === 'paid' && c3.status(w.id).txid === 'cd'.repeat(32) && c3.balance(alice.did) === 3930);
// a transfer the published copy cannot take (overdrawn there) is dropped rather than shown
const r3 = await c3.request({ op: 'transfer', amount: 999999, to: bob.did }, bob); // the library signs it (it does not know balances); the copy refuses it
t('a transfer that overdraws is dropped from the local copy rather than shown as a negative balance; the operator will refuse it too', c3.balance(bob.did) >= 0 && c3.status(r3.id).state === 'dropped');
t('a signer from a key has the did of its key; a bad hash is refused', alice.did.startsWith('did:nostr:') && await C.openLedger('xyz', {}).then(() => false, (e) => /64 hex/.test(e.message)));
t('a ledger no relay has is refused', await C.openLedger('ab'.repeat(32), { T, deps, relays, net: { fetchLedger: async () => null, publish: async () => 'ok' } }).then(() => false, (e) => /no relay/.test(e.message)));
c.stop(); c2.stop(); c3.stop();
console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
