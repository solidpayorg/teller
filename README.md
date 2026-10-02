# Teller

A teller for [Web Ledgers](https://webledgers.org/): accounts are did:nostr keys, balances a Web Ledger, deposits one taproot address per account, withdrawals and transfers signed requests. One operator holds the deposits and writes the ledger; everyone else reads it and signs requests. The proposal is [solidpayorg/webledgers#7](https://github.com/solidpayorg/webledgers/issues/7).

Live: https://solidpayorg.github.io/teller/ — on **txbt4**, the BLAKE2b testnet4, test coins with no value. Keys are kept in the browser unencrypted, which is fine for test coins and nothing else.

## How it works

- **The ledger** is a Web Ledger JSON document with a `genesis` (operator, name, currency, confirmations) fixed at creation; its **hash** is the sha256 of the genesis's canonical bytes (JCS) and is its identity. The operator publishes it as a Nostr event (kind 30333, addressable by `d` = the hash) and replaces it as balances move. A reader accepts only the operator's own signed copy.
- **Deposits.** Each account's deposit address is the operator's point tweaked by `tagged("webledgers/deposit", ledgerHash || account || nonce)`, added to the full point and never its even-y lift (sidestr/spec `keys.mjs`). Anyone with the operator's did and the ledger's hash recomputes it; only the operator can spend it. The operator scans the addresses through the explorer and credits each confirmed output once, by outpoint.
- **Requests** are Nostr events of kind 3700 signed by the account's key: `join` (be watched), `withdraw` (an amount to an address), `transfer` (an amount to an account). A transfer applies itself on sight; a withdrawal waits for the operator, who pays it out by hand: the deposits are the coins, each input signed with its own derived secret, the transaction checked under the chain's rules, broadcast, and the ledger debited and republished.
- **Paying in** is any wallet that reads a `bitcoin:` request; the page links to [Reef](https://bitcoin-blake.github.io/reef/) with the address filled in.

What it is not: not private (anyone who knows the operator's point can link a ledger's deposit addresses), not hardware-wallet signable (a plain additive tweak; see the proposal for the BIP 341 tree form), and custodial: the operator can refuse a withdrawal. It is checkable: every deposit traces to an account from public data, every change is a signed request or a deposit seen on-chain.

## The automatic operator

`bin/operator.mjs` does what the operator panel does by hand, every minute, unattended: it applies transfers, notes joins, credits confirmed deposits seen through the explorer, pays withdrawals under two caps (`--max-payout` per payout, `--max-hour` per hour, defaults 100,000 and 500,000 sat; the rest wait with a reason in the log, for a hand on the page) and publishes the ledger when anything changed. The secret is read from a file (`--key-file`), never the command line; the state (the ledger, the joined accounts, a status line) lives in `--dir`. A payout is noted on disk before it is broadcast and finished after, so a crash between the two re-broadcasts the same transaction rather than signing a second one. `--once` runs one tick, `--dry` broadcasts and publishes nothing.

    node bin/operator.mjs --key-file ~/.teller/x/operator.key --ledger <hash> --dir ~/.teller/x [--every 60] [--max-payout 100000] [--max-hour 500000] [--once] [--dry]

## Files

- `lib/teller.mjs`: the rules, pure (no DOM, storage or network): the ledger and its hash, credit/debit/transfer applied once, deposit addresses and secrets, requests built and verified, payouts planned and signed per input and checked by the kernel.
- `teller.js`, `index.html`: the page. Libraries pinned by commit from the CDN: the engine (bitcoin-desktop/schema) and the sidestr library (keys, signing, addresses, relays). Chain data from mempool.guide/testnet4. `?dry=1` publishes and broadcasts nothing.
- `lib/operator.mjs`, `test/operator-test.mjs`: the operator's decisions, pure: which withdrawals to pay this tick, oldest first under the caps, and why the rest wait.
- `test/teller-test.mjs`: `npm test` (`SCHEMA`, `BLAKETESTNODE`, `SIDESTR_LIB` pointing at checkouts, defaults under `~`), 22 checks against the kernel, including a two-input payout signed with two different derived secrets passing the chain's script check.

## Releasing

GitHub Pages serves `main` as it is. Run `npm test`, push.

AGPL-3.0-or-later.
