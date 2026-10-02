// A teller for Web Ledgers (solidpayorg/webledgers#7): accounts are did:nostr keys, balances a Web Ledger, deposits
// paid to one taproot address per account derived from the operator's key, withdrawals and transfers signed requests.
// Pure: no DOM, no storage, no network; the page and the tests wire the chain and the relays. Amounts are integers of
// satoshis inside and strings in the ledger (Web Ledgers writes amounts as strings; no floating point anywhere).
// The key rule (sidestr/spec keys.mjs): full points, the operator's secret normalised once, tweaks added to the point
// as it is, x-only only at the output and inside a signature.
export const DEPOSIT_TAG = 'webledgers/deposit';
export const LEDGER_KIND = 30333; // the ledger, addressable by d = its hash (the operator replaces it as balances move)
export const REQUEST_KIND = 3700; // a request: join, withdraw, transfer; regular, signed by the account's key
export const DUST = 330, MIN_PAY = 546;
export const CONTEXT = 'https://w3id.org/webledgers';
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(String(h).match(/../g) ?? [], (x) => parseInt(x, 16));
const utf8 = (t) => new TextEncoder().encode(t);
const isX = (s) => /^[0-9a-f]{64}$/.test(s);
/** JCS (RFC 8785) for the plain JSON these documents are: keys sorted at every level; numbers as JSON writes them */
export const jcs = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(jcs).join(',') + ']' : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + jcs(v[k])).join(',') + '}');
/** an account: did:nostr:<x>, from a did, an npub-less x, or a Multikey's x */
export const accountOf = (id) => { const s = String(id ?? '').trim().toLowerCase(); const x = /^(?:did:nostr:)?([0-9a-f]{64})$/.exec(s)?.[1] ?? /^fe7010[23]([0-9a-f]{64})$/.exec(s)?.[1]; if (!x) throw new Error('an account is a did:nostr identifier (did:nostr:<64 hex>)'); return 'did:nostr:' + x; };
export const xOf = (account) => accountOf(account).slice('did:nostr:'.length);
/** amounts: whole satoshis as integers, never beyond 21 million coins, never negative */
export const sats = (v) => { const n = typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN) : v; if (!Number.isInteger(n) || n < 0 || n > 21e14) throw new Error('an amount is a whole number of satoshis'); return n; };

// ---- the ledger
/** a new ledger: its genesis fields fixed at creation, its hash the sha256 of their JCS (never of the moving balances) */
export function newLedger({ hash }, { operator, name, currency = 'txbt4', created = Math.floor(Date.now() / 1000), confirmations = 1 }) {
  const genesis = { operator: accountOf(operator), name: String(name), currency: String(currency), created: Number(created), confirmations: Number(confirmations) };
  if (!genesis.name || genesis.name.length > 80) throw new Error('a ledger has a name of up to 80 characters');
  const h = hex(hash.sha256(utf8(jcs(genesis))));
  return { '@context': CONTEXT, type: 'WebLedger', id: 'urn:webledgers:' + h, hash: h, name: genesis.name, defaultCurrency: genesis.currency, genesis, updated: genesis.created, entries: [], deposits: [], applied: [], payouts: [] };
}
/** the ledger's hash recomputed from its genesis: a document whose hash does not match its genesis is not that ledger */
export const ledgerHash = ({ hash }, ledger) => hex(hash.sha256(utf8(jcs(ledger.genesis))));
export const checkLedger = (deps, ledger) => { if (!ledger || ledger.type !== 'WebLedger' || !ledger.genesis) throw new Error('not a Web Ledger with a genesis'); if (ledgerHash(deps, ledger) !== ledger.hash) throw new Error("the ledger's hash is not the hash of its genesis"); return true; };
const entry = (ledger, account) => ledger.entries.find((e) => e.url === account);
export const balance = (ledger, account) => { const e = entry(ledger, accountOf(account)); return e ? sats(e.amount) : 0; };
const setBalance = (ledger, account, n) => { const e = entry(ledger, account); if (e) e.amount = String(n); else ledger.entries.push({ type: 'Entry', url: account, amount: String(n) }); };
const touch = (ledger, now) => { ledger.updated = Math.max(ledger.updated ?? 0, now ?? Math.floor(Date.now() / 1000)); return ledger; };
/** a deposit seen on-chain credits its account once: the outpoint is the receipt */
export function credit(ledger, { account, txid, vout, value, height = null }, now) {
  const a = accountOf(account); const key = `${txid}:${vout}`; if (!/^[0-9a-f]{64}:\d+$/.test(key)) throw new Error('a deposit is an outpoint txid:vout');
  if (ledger.deposits.some((d) => d.outpoint === key)) return { applied: false, why: 'already credited' };
  const v = sats(value); setBalance(ledger, a, balance(ledger, a) + v); ledger.deposits.push({ outpoint: key, account: a, value: v, height, at: now ?? Math.floor(Date.now() / 1000) }); touch(ledger, now); return { applied: true };
}
/** a transfer between accounts, by a signed request already verified (parseRequest); applied once by its id */
export function transfer(ledger, { id, from, to, amount }, now) {
  const f = accountOf(from), t = accountOf(to), v = sats(amount); if (v === 0) throw new Error('a transfer moves at least one satoshi');
  if (ledger.applied.includes(id)) return { applied: false, why: 'already applied' };
  if (balance(ledger, f) < v) throw new Error(`${f.slice(0, 20)}… has ${balance(ledger, f)} sat, not ${v}`);
  setBalance(ledger, f, balance(ledger, f) - v); setBalance(ledger, t, balance(ledger, t) + v); ledger.applied.push(id); touch(ledger, now); return { applied: true };
}
/** a withdrawal debits the account when the operator pays it out; the payout's txid is the receipt */
export function debit(ledger, { id, account, amount, to, txid }, now) {
  const a = accountOf(account), v = sats(amount); if (v < MIN_PAY) throw new Error(`a withdrawal is at least ${MIN_PAY} sat`);
  if (ledger.applied.includes(id)) return { applied: false, why: 'already applied' };
  if (balance(ledger, a) < v) throw new Error(`${a.slice(0, 20)}… has ${balance(ledger, a)} sat, not ${v}`);
  setBalance(ledger, a, balance(ledger, a) - v); ledger.applied.push(id); ledger.payouts.push({ id, account: a, value: v, to, txid, at: now ?? Math.floor(Date.now() / 1000) }); touch(ledger, now); return { applied: true };
}
export const total = (ledger) => ledger.entries.reduce((s, e) => s + sats(e.amount), 0);

// ---- deposit addresses: one per account (and nonce), derived from the operator's point; anyone can recompute them
const nonce8 = (n) => { const b = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
/** { tweak, point, xOnly, script, address }: t = tagged(DEPOSIT_TAG, ledgerHash32 || account32 || nonce8), Q = P + t·G */
export function depositAddress({ keys, address }, { operatorPoint, ledgerHash: lh, account, nonce = 0, hrp = 'tb' }) {
  if (!isX(lh)) throw new Error("ledgerHash is the ledger's 32-byte hash");
  // the operator is its did: the even-y (02) point of its x, whatever the parity of the point its secret happens to give;
  // depositSecret normalises the secret to that same point, so the two agree (a 03 operator point here once broke that)
  const P = keys.basePoint(keys.did(keys.basePoint(operatorPoint)));
  const t = keys.taggedScalar(DEPOSIT_TAG, lh, xOf(account), nonce8(nonce)); const Q = keys.tweakPoint(P, t); const x = keys.xOnly(Q);
  return { tweak: t, point: Q, xOnly: x, script: '5120' + x, address: address.scriptToAddress('5120' + x, hrp), account: accountOf(account), nonce };
}
/** the operator's secret for a deposit: normalise(d) + t; the sign a signature needs is applied inside the signing */
export const depositSecret = ({ keys }, operatorSecret, tweak) => keys.tweakSecret(keys.normalize(operatorSecret), tweak);
/** the addresses to watch: every account the ledger knows (entries, deposits) and any extra (joined but empty), nonce 0 */
export function watchList(deps, ledger, operatorPoint, extraAccounts = []) {
  const accounts = new Set([...ledger.entries.map((e) => e.url), ...ledger.deposits.map((d) => d.account), ...extraAccounts.map(accountOf)]);
  return [...accounts].map((a) => depositAddress(deps, { operatorPoint, ledgerHash: ledger.hash, account: a }));
}

// ---- requests: Nostr events signed by the account's key; applied at most once by their id
/** a request event: join (be watched), withdraw (amount, to an address), transfer (amount, to an account) */
export function requestTags({ ledgerHash: lh, op, amount = null, to = null, id = null }) {
  if (!isX(lh)) throw new Error("ledgerHash is the ledger's hash"); if (!['join', 'withdraw', 'transfer'].includes(op)) throw new Error('op is join, withdraw or transfer');
  const tags = [['ledger', lh], ['op', op], ['id', id ?? hex(crypto.getRandomValues(new Uint8Array(16)))]];
  if (op !== 'join') { tags.push(['amount', String(sats(amount))]); if (!to) throw new Error('a withdrawal or transfer names where to'); tags.push(['to', op === 'transfer' ? accountOf(to) : String(to).trim()]); }
  return tags;
}
export const requestEvent = ({ events }, key, req) => events.signEvent(key, { kind: REQUEST_KIND, tags: requestTags(req), content: '' });
/** a request read back: verified, for this ledger, the account its author */
export function parseRequest(ev, { verify, ledgerHash: lh }) {
  if (!ev || ev.kind !== REQUEST_KIND) throw new Error('not a request (kind 3700)'); let ok = false; try { ok = !!verify(ev); } catch {} if (!ok) throw new Error('the request does not verify');
  const tag = (n) => (ev.tags ?? []).find((t) => t[0] === n)?.[1]; if (tag('ledger') !== lh) throw new Error('a request for another ledger'); const op = tag('op'), id = tag('id');
  if (!['join', 'withdraw', 'transfer'].includes(op) || !id || !/^[0-9a-f]{8,64}$/.test(id)) throw new Error('a request has an op and an id');
  const r = { id, op, account: 'did:nostr:' + ev.pubkey, created_at: ev.created_at, event: ev };
  if (op !== 'join') { r.amount = sats(tag('amount')); r.to = tag('to'); if (!r.to) throw new Error('a withdrawal or transfer names where to'); if (op === 'transfer') r.to = accountOf(r.to); }
  return r;
}

// ---- payouts: the deposits are the coins; each input is signed with its own derived secret
// a key-path input weighs 41 vB plus a 66-byte witness (a 65-byte signature with its hash type, and its length) at a
// quarter: 57.5 vB on paper, 58 once rounded with the rest; one short was refused as "min relay fee not met, 154 < 155"
const vsizeEstimate = (nIn, nOut) => Math.ceil(11 + 58 * nIn + 43 * nOut);
/** the signed transaction's virtual size, from its bytes: (3 × stripped + full) / 4, rounded up */
export const vsizeOf = (k, tx) => { const full = k.codec.encodeHex('Transaction', tx).length / 2, stripped = k.codec.encodeHex('Transaction', { ...tx, witness: [] }).length / 2; return Math.ceil((3 * stripped + full) / 4); };
/** pick deposits to pay `amount` to `toScript` at `rate`, change back to `changeScript` (a deposit address of the operator's own account) */
export function planPayout({ coins, amount, rate = 1, toScript, changeScript }) {
  const v = sats(amount); if (v < MIN_PAY) throw new Error(`a payout is at least ${MIN_PAY} sat`); if (!(rate >= 1 && rate <= 1000)) throw new Error('rate 1 to 1000 sat/vB');
  const sorted = [...coins].sort((a, b) => b.value - a.value); const picked = []; let inSum = 0;
  for (const c of sorted) { picked.push(c); inSum += c.value; const fee = Math.ceil(rate * vsizeEstimate(picked.length, 2)); if (inSum >= v + fee) { const change = inSum - v - fee; if (change >= DUST) return { picked, outputs: [{ value: v, scriptPubKey: toScript }, { value: change, scriptPubKey: changeScript }], fee, change, rate }; const fee1 = Math.ceil(rate * vsizeEstimate(picked.length, 1)); if (inSum >= v + fee1) return { picked, outputs: [{ value: v, scriptPubKey: toScript }], fee: inSum - v, change: 0, rate }; } }
  throw new Error(`the deposits held (${inSum} sat) do not cover ${v} sat and the fee`);
}
export const unsignedTx = (p) => ({ version: 2, inputs: p.picked.map((c) => ({ prevout: { txid: c.txid, vout: c.vout }, scriptSig: '', sequence: 0xfffffffd })), outputs: p.outputs.map((o) => ({ ...o })), lockTime: 0, witness: [] });
/** sign every input with its deposit's own secret (operator secret + that deposit's tweak), then check each under the chain's rules */
export function signPayout({ k, hash, signer, keys, txsign }, p, operatorSecret) {
  const tx = unsignedTx(p); const prevouts = p.picked.map((c) => ({ value: c.value, scriptPubKey: c.script }));
  tx.witness = tx.inputs.map((_, i) => { const { m, ht } = txsign.keyPathSighash({ k, hash }, tx, i, prevouts); const d = depositSecret({ keys }, operatorSecret, p.picked[i].tweak); return [hash.bytesToHex(signer.schnorrSign(m, d)) + ht.toString(16).padStart(2, '0')]; });
  const unified = txsign.usesUnifiedSighash(k);
  for (let i = 0; i < tx.inputs.length; i++) { const v = k.interpreter.verifyInput(tx, i, prevouts[i], prevouts, null, { unifiedSighash: unified }); if (v.ok !== true) throw new Error(`input ${i} did not pass the script check (${v.error ?? v.reason ?? '?'}); nothing was paid`); }
  const vsize = vsizeOf(k, tx); if (p.fee < Math.ceil((p.rate ?? 1) * vsize)) throw new Error(`the signed payout is ${vsize} vB, so its fee of ${p.fee} sat is below ${p.rate ?? 1} sat/vB; nothing was paid`);
  return { tx, hex: k.codec.encodeHex('Transaction', tx), txid: k.codec.txid(tx), vsize };
}
