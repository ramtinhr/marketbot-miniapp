# Rial peer payments

All amounts are **Toman (IRT)**, matching the existing wallet and rial board.

A `p2p` receive request (`side=want`) requires payment instructions in its
120-character description. Placement atomically freezes the full IRT amount;
insufficient balance rolls back the request. Legacy unfunded demo offers are
excluded from reservations. New P2P requests are not exposed on the public board.

`POST /api/v1/p2p/reserve {amount}` reserves enough requests to cover the exact
amount, oldest first, possibly splitting the final request. Insufficient supply
rolls back the entire selection. A request with an unpaid reservation is hidden
from every other payer, including its unallocated remainder. Repeating selection
returns the existing unpaid selection without extending its two-minute deadline.
The returned list lets the payer pay each recipient separately; each recipient
requires their own receipt. Selection does not settle or credit any money.

The payer must upload a PNG/JPEG/WebP receipt (up to 530,000 bytes) and a bank
reference before expiry. Do not transfer after the displayed deadline. Unpaid
reservations expire without releasing the receiver's escrow; that allocation is
made available again. An uploaded receipt never expires back into the market.

Only the receiver can confirm or dispute a pending receipt. Confirmation settles
the receiver's frozen IRT to the payer's available balance in the same transaction
as the ledger and payment state. A dispute immediately enters admin review;
unanswered receipts enter review 30 minutes after submission. No automatic
financial approval occurs. Admin review prevents further customer confirmation.
An open request cannot be cancelled while payments are pending.

The worker checks every 10 seconds. Customer operations also sweep deadlines;
the admin queue includes overdue receipts even if the worker is offline. All
allocation, cancellation and settlement paths use the same PostgreSQL transaction
advisory lock. Settlement locks the payment and wallets, checks held balances,
and writes ledger entries atomically. Replayed confirmations do not credit twice.

The authenticated backoffice API exposes `/backoffice/v1/p2p/payments` and
`/backoffice/v1/p2p/payments/:id/review`. Reviews require the `p2p-review` intent
header, current revision, a reason, and `settled` or `rejected` decision. Rejecting
returns escrow to the receiver. Actor and reason remain on the payment; ledger
entries reference the payment ID. The dashboard displays this queue on Withdrawals.

Deploy the Mini App server first so its startup schema migration creates the
P2P table and shared settlement function, then deploy marketbot-api and
marketbot-web. No live data migrations or deployment are performed by this change.

Tests: `node --test server/test/p2p.test.js server/test/p2p-routes.test.js`.
These run real PostgreSQL SQL and PL/pgSQL in PGlite with serialized connection
access; they do not substitute for multi-process load testing on PostgreSQL.
