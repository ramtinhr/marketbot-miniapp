# Engine P2P reservations

P2P reserve requests now enqueue durable commands in the shared Postgres
`public.marketbot_p2p_commands` table. marketbot-em's dedicated P2P worker owns
allocation; there is no local matching fallback. Receipts, disputes and settlement
keep their existing behavior. The worker does not execute P2P as spot trades.

Before deploying this Mini App version, run marketbot-api's `npm run migrate`
through `008_p2p_engine_commands`, then start marketbot-em with `P2P_ENABLED=true`
against the same database. Updated API and Mini App versions can then be deployed.
Existing payments and offers require no conversion. A missing/stopped worker
returns `p2p_engine_unavailable` (503) after ten seconds; pending commands are
cancelled on timeout. A committed allocation wins a timeout race.
