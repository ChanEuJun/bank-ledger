# Cache each account's balance, and prove it with `verify`

Each account stores a cached `balance_minor` alongside the append-only postings that are its real source of truth. We cache instead of summing postings on every read because reads stay cheap, and because the cached row gives concurrent transfers a single thing to contend over, which is exactly the overdraft and double-spend problem this project exists to explore. The cost is that the cache can drift from the postings, so `pnpm verify` recomputes every balance from postings and must run in CI, after every load test, and (later) on a schedule that alerts on any drift.

## Considered Options

- **Derive balance from postings on every read**: no drift possible, but reads get slower as postings grow, and the no-overdraft check would need to lock or aggregate postings instead of one account row.

## Consequences

- The no-overdraft check and the balance update happen against the account row inside the same transaction as the postings insert. The locking strategy for that row is deliberately left open: it gets decided after a naive version is shown failing under concurrency.
