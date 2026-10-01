// lib/teller.mjs against the engine: the ledger's arithmetic, deposit addresses (two ledgers → two addresses from one
// operator key, anyone recomputes them), signed requests applied once, and a payout signed per input with each deposit's
// own secret and checked under the chain's script rules (the kernel for btc:testnet4-blake2b).
//   SCHEMA=<bitcoin-desktop/schema> BLAKETESTNODE=<path> SIDESTR_LIB=<siding/lib> node test/teller-test.mjs
import os from 'node:os';
const H = (p) => p.replace(/^~/, os.homedir());
const SCHEMA = H(process.env.SCHEMA ?? '~/bitcoin-desktop/schema'), BTN = H(process.env.BLAKETESTNODE ?? '~/remote/github.com/bitcoin-blake/blaketestnode'), LIB = H(process.env.SIDESTR_LIB ?? '~/remote/github.com/sidestr/spec/siding/lib');
const [{ loadEngine }, hash, secp, { makeSigner }, { makeKeys }, txsign, address, { makeEvents }, T] = await Promise.all([
  import(`${BTN}/lib/engine.mjs`), import(`${SCHEMA}/codec/hash.js`), import(`${SCHEMA}/codec/secp256k1.js`), import(`${LIB}/schnorr.mjs`), import(`${LIB}/keys.mjs`), import(`${LIB}/txsign.mjs`), import(`${LIB}/address.mjs`), import(`${LIB}/relay.mjs`), import('../lib/teller.mjs')]);
const { verifyNostrEvent } = await import(`${SCHEMA}/codec/nostr.js`);
const k = await loadEngine('btc:testnet4-blake2b'); const signer = makeSigner({ hash, secp }), keys = makeKeys({ hash, secp }), events = makeEvents({ signer, hash });
const deps = { hash, secp, keys, address, signer, events, txsign, k };
let ok = 0, bad = 0;
const t = (name, cond, detail = '') => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : `\n        ${detail}`}`); cond ? ok++ : bad++; };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

// ---- the ledger
const opKey = signer.randomKey(), opPoint = keys.publicKey(opKey), opDid = keys.did(opPoint);
const L = T.newLedger(deps, { operator: opDid, name: 'Table 7', created: 1759300000 });
t('a new ledger is a Web Ledger with a genesis, its hash the sha256 of the genesis JCS, no balances', L.type === 'WebLedger' && L['@context'] === T.CONTEXT && L.hash === T.ledgerHash(deps, L) && L.id === 'urn:webledgers:' + L.hash && L.entries.length === 0 && T.checkLedger(deps, L));
t('the hash is of the genesis only: balances move, the hash does not; a tampered genesis is caught', (() => { const c = JSON.parse(JSON.stringify(L)); c.genesis.name = 'Table 8'; return throws(() => T.checkLedger(deps, c), /hash/); })());
t('JCS: keys sorted at every level, strings and numbers as JSON', T.jcs({ b: 1, a: { d: 'x', c: [2, { f: 0, e: null }] } }) === '{"a":{"c":[2,{"e":null,"f":0}],"d":"x"},"b":1}');
const alice = signer.randomKey(), bob = signer.randomKey(); const A = keys.did(keys.publicKey(alice)), B = keys.did(keys.publicKey(bob));
t('accounts are did:nostr identifiers, read from a did, a bare x or a Multikey', T.accountOf(A) === A && T.accountOf(A.slice(10)) === A && T.accountOf('fe70102' + A.slice(10)) === A && throws(() => T.accountOf('npub1x'), /did:nostr/));
const txid = 'ab'.repeat(32);
t('a deposit credits its account once: the outpoint is the receipt', T.credit(L, { account: A, txid, vout: 0, value: 50000, height: 152100 }, 1759300001).applied && T.balance(L, A) === 50000 && T.credit(L, { account: A, txid, vout: 0, value: 50000 }).applied === false && T.balance(L, A) === 50000 && L.entries[0].amount === '50000');
t('a transfer moves whole satoshis between accounts and is applied once by its id; it never overdraws', T.transfer(L, { id: 'r1', from: A, to: B, amount: 20000 }).applied && T.balance(L, A) === 30000 && T.balance(L, B) === 20000 && T.transfer(L, { id: 'r1', from: A, to: B, amount: 20000 }).applied === false && throws(() => T.transfer(L, { id: 'r2', from: B, to: A, amount: 20001 }), /has 20000 sat/) && T.total(L) === 50000);
t('a withdrawal debits when paid out, at least 546 sat, once by its id', T.debit(L, { id: 'w1', account: B, amount: 20000, to: 'tb1p…', txid: 'cd'.repeat(32) }).applied && T.balance(L, B) === 0 && T.debit(L, { id: 'w1', account: B, amount: 20000, to: 'tb1p…', txid: 'cd'.repeat(32) }).applied === false && throws(() => T.debit(L, { id: 'w2', account: A, amount: 100, to: 'x', txid }), /at least 546/) && L.payouts.length === 1 && T.total(L) === 30000);
t('amounts are whole satoshis, as strings in the ledger, never floats or negatives', T.sats('123') === 123 && throws(() => T.sats('1.5')) && throws(() => T.sats(-1)) && throws(() => T.sats(21e14 + 1)) && L.entries.every((e) => /^\d+$/.test(e.amount)));

// ---- deposit addresses
const dA = T.depositAddress(deps, { operatorPoint: opPoint, ledgerHash: L.hash, account: A });
t('a deposit address: a taproot output of the operator\'s point tweaked by tagged(ledgerHash || account || nonce)', dA.script === '5120' + dA.xOnly && /^tb1p/.test(dA.address) && dA.point === keys.tweakPoint(keys.basePoint(opPoint), dA.tweak) && dA.account === A);
t('anyone recomputes it from the operator\'s did alone (the 02 point): the same address', T.depositAddress(deps, { operatorPoint: opDid, ledgerHash: L.hash, account: A }).address === T.depositAddress(deps, { operatorPoint: keys.normalize(opKey) && keys.publicKey(keys.normalize(opKey)), ledgerHash: L.hash, account: A }).address);
const L2 = T.newLedger(deps, { operator: opDid, name: 'Table 8', created: 1759300000 });
t('two ledgers give two addresses for the same account from the same operator; two accounts on one ledger likewise; nonce 1 another again', T.depositAddress(deps, { operatorPoint: opPoint, ledgerHash: L2.hash, account: A }).address !== dA.address && T.depositAddress(deps, { operatorPoint: opPoint, ledgerHash: L.hash, account: B }).address !== dA.address && T.depositAddress(deps, { operatorPoint: opPoint, ledgerHash: L.hash, account: A, nonce: 1 }).address !== dA.address);
t('the operator\'s secret for a deposit signs for its output (normalise once, add the tweak, the sign inside the signing)', (() => { const d = T.depositSecret(deps, opKey, dA.tweak); const msg = hash.sha256(hash.hexToBytes(dA.xOnly)); return secp.verifySchnorr(msg, signer.schnorrSign(msg, d), hash.hexToBytes(dA.xOnly)); })());
t('the watch list covers every account the ledger knows and any that joined', T.watchList(deps, L, opPoint, [keys.did(keys.publicKey(signer.randomKey()))]).length === 3);

// ---- requests
const verify = verifyNostrEvent;
const rJoin = T.requestEvent(deps, alice, { ledgerHash: L.hash, op: 'join' }); const pj = T.parseRequest(rJoin, { verify, ledgerHash: L.hash });
t('a join request: kind 3700, for this ledger, the account its author, an id', rJoin.kind === T.REQUEST_KIND && pj.op === 'join' && pj.account === A && /^[0-9a-f]{32}$/.test(pj.id));
const rW = T.requestEvent(deps, bob, { ledgerHash: L.hash, op: 'withdraw', amount: 1000, to: 'tb1pfu64hh9hes90w2808n8tjc2ajp5yhddjef0ctx4s7zmsgp6cwx4quvla6g', id: 'deadbeef01' });
const pw = T.parseRequest(rW, { verify, ledgerHash: L.hash });
t('a withdrawal request carries the amount and the address, and parses back verified', pw.op === 'withdraw' && pw.amount === 1000 && pw.to.startsWith('tb1p') && pw.account === B && pw.id === 'deadbeef01');
const rT = T.parseRequest(T.requestEvent(deps, alice, { ledgerHash: L.hash, op: 'transfer', amount: 5, to: B }), { verify, ledgerHash: L.hash });
t('a transfer request names an account', rT.op === 'transfer' && rT.to === B && rT.amount === 5);
t('a tampered request, one for another ledger, a bad amount, or a withdrawal with no destination is refused in words', throws(() => T.parseRequest({ ...rW, content: 'x' }, { verify, ledgerHash: L.hash }), /verify/) && throws(() => T.parseRequest(rW, { verify, ledgerHash: L2.hash }), /another ledger/) && throws(() => T.requestEvent(deps, bob, { ledgerHash: L.hash, op: 'withdraw', amount: '1.5', to: 'tb1p' }), /whole number/) && throws(() => T.requestEvent(deps, bob, { ledgerHash: L.hash, op: 'withdraw', amount: 10 }), /names where/));

// ---- a payout, signed per input with each deposit's own secret, checked by the kernel
const dB = T.depositAddress(deps, { operatorPoint: opPoint, ledgerHash: L.hash, account: B });
const coins = [{ ...dA, txid: '11'.repeat(32), vout: 0, value: 40000 }, { ...dB, txid: '22'.repeat(32), vout: 1, value: 30000 }];
const dOp = T.depositAddress(deps, { operatorPoint: opPoint, ledgerHash: L.hash, account: opDid }); // change to the operator's own deposit address
const p = T.planPayout({ coins, amount: 50000, rate: 1, toScript: '5120' + '33'.repeat(32), changeScript: dOp.script });
t('planPayout picks enough deposits, pays the amount, returns change above dust, fee at the rate', p.picked.length === 2 && p.outputs[0].value === 50000 && p.outputs[1].scriptPubKey === dOp.script && p.change === 70000 - 50000 - p.fee && p.fee >= 1 && p.fee < 400);
const s = T.signPayout(deps, p, opKey);
t('signPayout signs input 0 with A\'s deposit secret and input 1 with B\'s (two different keys), and every input passes the chain\'s script check (unified sighash beside BLAKE2b)', s.tx.witness.length === 2 && s.tx.witness[0][0] !== s.tx.witness[1][0] && s.tx.witness.every((w) => w[0].length === 130) && /^[0-9a-f]{64}$/.test(s.txid) && s.hex.length > 200 && txsign.usesUnifiedSighash(k));
t('a payout signed with the wrong operator secret fails the script check and nothing is paid', throws(() => T.signPayout(deps, p, signer.randomKey()), /script check/));
t('a payout beyond the deposits held, or below 546 sat, is refused in words', throws(() => T.planPayout({ coins, amount: 70000, rate: 1, toScript: '5120' + '33'.repeat(32), changeScript: dOp.script }), /do not cover/) && throws(() => T.planPayout({ coins, amount: 100, rate: 1, toScript: '00', changeScript: '00' }), /at least 546/));
t('a payout that leaves dust folds it into the fee (one output)', (() => { const q = T.planPayout({ coins: [coins[0]], amount: 40000 - 200, rate: 1, toScript: '5120' + '33'.repeat(32), changeScript: dOp.script }); return q.outputs.length === 1 && q.fee === 200; })());

console.log(`\n${ok} passed, ${bad} failed`); process.exit(bad ? 1 : 0);
