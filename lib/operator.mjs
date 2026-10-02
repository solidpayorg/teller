// The automatic operator's decisions, pure (bin/operator.mjs is the wiring): which withdrawals to pay this tick, under
// a cap per payout and a cap per hour, oldest first; a request that fails a check is left waiting with its reason,
// never dropped, so a hand can still pay it later from the page.
import { balance, MIN_PAY } from './teller.mjs';
/** satoshis paid out in the last hour, from the ledger's payouts */
export const paidInHour = (ledger, now) => (ledger.payouts ?? []).filter((p) => now - p.at < 3600).reduce((s, p) => s + Number(p.value), 0);
/** { pay: [requests], held: [{ request, why }] }: the withdrawals to pay now, oldest first, and the ones left waiting */
export function withdrawalsToPay(ledger, requests, { maxPayout, maxHour, now, decodes = () => true }) {
  const pay = [], held = []; let hour = paidInHour(ledger, now);
  for (const r of [...requests].filter((r) => r.op === 'withdraw' && !ledger.applied.includes(r.id)).sort((a, b) => a.created_at - b.created_at)) {
    const why = r.amount < MIN_PAY ? `below the minimum of ${MIN_PAY} sat` : balance(ledger, r.account) < r.amount ? `the account has ${balance(ledger, r.account)} sat, not ${r.amount}` : !decodes(r.to) ? 'the address does not decode' : r.amount > maxPayout ? `above the cap of ${maxPayout} sat per payout: a hand pays it from the page` : hour + r.amount > maxHour ? `the hour's cap of ${maxHour} sat would be passed: waits for the next hour` : null;
    if (why) held.push({ request: r, why }); else { pay.push(r); hour += r.amount; }
  }
  return { pay, held };
}
