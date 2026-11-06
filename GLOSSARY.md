# Bank ledger

A mini core bank: a double-entry ledger that holds customers' money in accounts and moves it between them.

## Parties and accounts

**Customer**:
A person or organisation that holds one or more customer accounts at the bank. A party in the ledger, not a login.
_Avoid_: client, user, account holder

**Account**:
A named container of postings in a single currency, carrying a balance. Every account is either a customer account or an internal account.
_Avoid_: wallet, ledger account

**Customer account**:
An account owned by exactly one customer. Its balance never goes below zero.
_Avoid_: user account

**Internal account**:
An account owned by the bank itself rather than any customer, such as the settlement account or a fees account. Its balance may go below zero.
_Avoid_: system account, house account

**Settlement account**:
The internal account that stands in for the world outside the bank; money entering or leaving the bank passes through it. There is one per currency.
_Avoid_: suspense account, bank account

## Recording money

**Journal entry**:
One balanced, atomic accounting event: at least two postings, all in one currency, that sum to zero. Never edited; a correction is a new reversing entry.
_Avoid_: transaction, ledger entry

**Posting**:
One line of a journal entry: a non-zero signed amount against a single account. A positive amount raises the account's balance and a negative one lowers it, on every account, customer or internal. Never edited or deleted.
_Avoid_: line, leg, entry line

**Balance**:
The sum of an account's postings, in minor units.
_Avoid_: funds

**Balance as of**:
An account's balance at a past instant: the sum of its postings recorded at or before that instant. Only ever asked about the past, never the future.
_Avoid_: historical balance, snapshot

## Moving money

**Transfer**:
A request to move an amount from one account to another, tracked through a status history and identified by an idempotency key. When it posts, it produces one journal entry; a later correction is a separate reversing entry.
_Avoid_: payment, transaction

**Deposit**:
A transfer from the settlement account into a customer account, standing in for money arriving from outside the bank.
_Avoid_: funding, top-up

**Idempotency key**:
A caller-chosen string that identifies one intended transfer. Repeating a request with the same key and the same details returns the original outcome without moving money again; the same key with different details is rejected.
_Avoid_: request ID, dedupe key
