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
One balanced, atomic accounting event: a set of postings that sum to zero. Never edited; a correction is a new reversing entry.
_Avoid_: transaction, ledger entry

**Posting**:
One line of a journal entry: a signed amount against a single account. Never edited or deleted.
_Avoid_: line, leg, entry line

**Balance**:
The sum of an account's postings, in minor units.
_Avoid_: funds

## Moving money

**Transfer**:
A request to move an amount from one account to another, tracked through a status history and identified by an idempotency key. When it posts, it produces exactly one journal entry.
_Avoid_: payment, transaction

**Deposit**:
A transfer from the settlement account into a customer account, standing in for money arriving from outside the bank.
_Avoid_: funding, top-up
