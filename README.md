# marketbot-miniapp

MarketBot's Telegram Mini App — the users' app, in Persian: a wallet (balances, charge by card, withdrawals) and a trade page (live order book, limit and market orders). It is a product of its own, separate from the admins' dashboard ([marketbot-web](../marketbot-web)) and its API ([marketbot-api](../marketbot-dashboard)): it has its own UI, its own server and its own sessions. It shares the bot's Postgres, where it keeps its own `miniapp_*` tables and uses the exchange engine's `exchange.*` wallets, orders and trades, and talks to the engine ([marketbot-engine](../marketbot-engine)) over its Kafka topics, as the dashboard does.

| Folder | What it is |
|---|---|
| `server/` | Fastify (Node, plain JS). Telegram sign-in, the app's users and sessions, and the app's API under `/api/v1`. |
| `web/` | Vite + React 19 + TypeScript. The Mini App itself, Persian and right-to-left, in Telegram's theme colours. |

One npm workspace: `npm install` at the root installs both.

## Sign-in

Users sign in with the Iranian mobile number of their Telegram account, which Telegram vouches for; then, because the app holds money, they confirm it with an SMS code (below).

1. The app opens inside Telegram and posts the launch parameters (`initData`) to `POST /api/v1/auth/telegram`. The server checks Telegram's signature (HMAC with a key derived from `BOT_TOKEN`) and its age.
2. An account that has signed in before gets a session straight away. A new one gets `{"status": "phone_required"}`.
3. The app calls `Telegram.WebApp.requestContact()`. The user confirms sharing, and Telegram hands the app the contact **signed the same way**. The app posts it to `POST /api/v1/auth/phone` with the launch parameters.
4. The server checks both signatures, that the contact is the same account that opened the app, and that the number is an Iranian mobile (`+98 9…`, stored as `+989XXXXXXXXX`). Anything else is refused with `phone_not_iranian`.

A session is a random bearer token (only its SHA-256 is stored), sent as `Authorization: Bearer …`. It ends `SESSION_TTL_HOURS` after sign-in or `SESSION_IDLE_MINUTES` after its last request; reopening the app from Telegram signs in again without asking for the phone.

A number belongs to whichever account Telegram last said holds it: if a second Telegram account shares a number another account had, the first one loses the number and its sessions, and is asked to share a number on its next visit.

Errors are `{"error": "...", "code": "..."}`. The app shows its own Persian text per `code` (`web/src/i18n/fa.ts`, `error.*`).

| Endpoint | |
|---|---|
| `POST /api/v1/auth/telegram` | `{init_data}` → `{status: "ok", token, user}` or `{status: "phone_required"}` |
| `POST /api/v1/auth/phone` | `{init_data, contact}` → `{status: "ok", token, user}` |
| `POST /api/v1/auth/logout` | ends the bearer session |
| `GET /api/v1/me` | `{user, verified}` |
| `GET /health` | liveness |

### SMS code

A session reaches nothing to do with money until its owner types the 6-digit code sent by SMS (Kavenegar's verify template) to the account's number: `POST /auth/otp/send`, then `POST /auth/otp/verify {code}`. Until then those routes answer 403 `otp_required`. Verifying also links the user to an `exchange.users` account (found by phone, or created), whose wallets the app shows. Every withdrawal needs a fresh code of its own.

Only an HMAC of each code is stored. A code expires after `OTP_TTL_SECONDS`, allows `OTP_MAX_ATTEMPTS` tries and works once; a new one can be asked for after `OTP_RESEND_SECONDS`, at most `OTP_MAX_PER_HOUR` an hour. A withdrawal's code is only used up if the withdrawal goes through.

## Wallet and trading

All of these need a verified session.

| Endpoint | |
|---|---|
| `GET /wallet` | `{balances, assets, prices}` - prices in Toman at each book's best bid |
| `GET /wallet/entries?asset&before` | the ledger, newest first, 30 a page |
| `GET /wallet/charge` | `{min_toman, max_toman, provider, payments}` |
| `POST /wallet/charge` | `{amount}` (Toman) → `{payment_id, url}`; the app opens `url` (the gateway) in the browser |
| `GET /payments/callback` | where the gateway returns; verifies and credits once (idempotent), no session |
| `GET /wallet/withdrawals` | `{networks, withdrawals}` |
| `POST /wallet/withdrawals/otp` | sends the withdrawal's code |
| `POST /wallet/withdrawals` | `{asset, amount, network, destination, code}`; Toman goes to a Sheba (`IR` + 24 digits, mod-97 checked). Freezes the amount |
| `POST /wallet/withdrawals/:id/cancel` | while pending; unfreezes |
| `GET /market/symbols`, `GET /market/:symbol` | pairs; a pair's `{depth, summary, trades}` (public) |
| `GET /orders?symbol&scope`, `GET /trades?symbol` | the user's orders (`open`/`history`/`all`) and fills |
| `POST /orders` | `{symbol, side, type: "limit"\|"market", price?, quantity}` |
| `POST /orders/:id/cancel` | |
| `GET /auction/:symbol` | the pair's auction `{book, trades}` (public) |
| `GET /auction/orders?symbol&scope` | the user's auction orders |
| `POST /auction/orders` | `{symbol, side, price, quantity}` → `{order, trades}` |
| `POST /auction/orders/:id/cancel` | unfreezes what the order still holds |
| `POST /auction/offers/:id/take` | `{quantity}` → `{order, trades}`: takes that much of one offer on the board, at its price |
| `GET /market/ws` | WebSocket: send `{type:"auth", token}` and `{type:"subscribe", symbol}`; get `depth`, `trades`, `user` (own orders and fills), `balances`, and for the auction `auction_book`, `auction_offers`, `auction_trades`, `auction_user` |

The **auction** is a second book per pair where users trade only with each other - never with venue liquidity, the engine or Kafka. An auction order says "buy (or sell) X at Y": it fills at once against crossing auction orders of other users, best price first, each fill at the resting order's price, and the rest stays on the auction book until it fills or is cancelled. What it may spend (Toman at its limit for a buy, the coin for a sell) is frozen in the exchange wallet while it is open; a buy filled below its limit gets the difference back. Placing, matching and settling happen in one Postgres transaction under a lock per pair (`src/auction.js`; tables `miniapp_auction_orders` and `miniapp_auction_trades`). On the trade page, tapping Buy or Sell opens a sheet to choose market, limit or auction; auction switches the book, form and lists to the auction's.

The auction has two views, switched at the top of the page (the choice is remembered). **آگهی‌ها** (the default) shows it the way Telegram's USDT trading groups work: every open order is a post - «تتر را به قیمت ۱۰۲٬۳۵۰ تومان با حجم ۱۲۰ می‌خرم» - newest at the bottom, the user's own on the other side with a button to withdraw it. A new post is written as the same sentence with blanks («من تتر را به قیمت … تومان با حجم … می‌خرم/می‌فروشم»). Others' posts have «از او می‌خرم» / «به او می‌فروشم», which opens a sheet for how much of it to take: `POST /auction/offers/:id/take` fills against that one order only, at its price - even if a better one is on the board - and never rests (`409 offer_gone`, `offer_short` with `remaining`, or `own_offer` otherwise). `GET /auction/:symbol` also returns `offers` (open orders one by one, newest first, without their owners), pushed again as `auction_offers` on every change. **دفتر سفارش** is the same orders as a price-level book, with the order form.

The engine matches limit orders only. A **market** order is sent as a limit order priced `MARKET_SLIPPAGE_BPS` past the deepest level it needs, and whatever does not fill at once is cancelled. On the trade page's **limit** tab the price follows the best price on the other side of the book (best ask to buy, best bid to sell) until the user types one, so normally only the amount is entered; tapping a book row sets that price.

A withdrawal request only freezes the amount: paying it out (a debit from frozen) or rejecting it (an unfreeze) is an operator's job, not built here yet. Crypto deposits are not available yet.

## The bot's chat

A new chat shows the bot's description above Telegram's own Start button. `/start` (and any other message) answers with a welcome and a reply keyboard: **باز کردن مارکت‌بات** and **شارژ کیف پول** answer with an inline button into the Mini App, **مزایده** with one into the auction, **موجودی من** shows the wallet's balances right in the chat (with a refresh button). The keyboard's buttons are plain text because a Mini App opened from a keyboard button gets no launch parameters, which sign-in needs; the menu button beside the text field opens the app in one tap. `/balance` and `/auction` (also `t.me/<bot>?start=balance|auction`) go straight to those. The chat's menu button opens the Mini App. Balances are shown to the Telegram account that owns the wallet, once it has an exchange account (after its first SMS code); before that the bot says to sign up in the app.

The buttons open the app with `?screen=auction|wallet|charge|trade` (a `t.me/<bot>/<app>?startapp=` link's start parameter works too). Updates arrive by webhook at `POST /api/v1/telegram/webhook`, checked against a secret derived from `BOT_TOKEN`, and the reply is the response body - so the bot answers even though Telegram is blocked from the server. The webhook, the menu button and the commands are registered once, through the bot's relay (`TELEGRAM_PROXY_URL`, the same as the bot's alerts), and Telegram keeps them; run it again only if `PUBLIC_URL` or `BOT_TOKEN` changes:

```bash
cd server && npm run bot:setup     # reads server/.env; prints the webhook Telegram now has
```

(`BOT_UPDATES` in `.env.example`; `src/bot.js`.)

## Running

```bash
npm install
cp server/.env.example server/.env   # set BOT_TOKEN, DB_* and KAFKA_BROKERS
npm run dev:server                   # http://localhost:8090
npm run dev:web                      # http://localhost:5174, proxies /api (and its WebSocket) to the server
                                     #   ?preview=loading|outside|phone|phone-error|error|otp|home|
                                     #   wallet|asset|charge|deposit|withdraw|trade shows a screen with
                                     #   sample data and a fake live book, outside Telegram (code: 123456)
npm test                             # server tests
npm run build                        # type-checks and builds web/dist
```

The server tests include a Postgres one that is skipped unless `TEST_DB_PORT` is set. It drops the `miniapp_*` tables, so give it a throwaway database:

```bash
docker run -d --rm --name miniapp-pg -e POSTGRES_USER=marketbot -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
TEST_DB_PORT=55432 TEST_DB_PASSWORD=test npm test
```

### Opening it in Telegram

Telegram only opens Mini Apps over HTTPS, and the app only works inside Telegram (in a browser it says so). For development:

1. Expose the Vite server over HTTPS, e.g. `cloudflared tunnel --url http://localhost:5174` or `ngrok http 5174`.
2. In [@BotFather](https://t.me/BotFather): `/mybots` → your bot → *Bot Settings* → *Configure Mini App* (or *Menu Button*), and set the tunnel's URL.
3. Put that bot's token in `server/.env` as `BOT_TOKEN`, start both halves, and open the bot in Telegram.

Use a separate bot for development, so its URL can point at your tunnel.

## Deploying

Locally, `docker compose up --build` runs both images on the host network: the server on `PORT` (8090), and nginx serving the app on `WEB_PORT` (8082) with `/api` proxied to the server.

Production works like the other MarketBot services: CI builds the images, a manual workflow ships them to the server over SSH (the server has no route to a registry), and `docker-compose.prod.yml` runs them there. Both containers listen on loopback only; marketbot-api's nginx terminates TLS for the app's domain.

| Workflow | When | What |
|---|---|---|
| `.github/workflows/ci.yml` | push and pull request to `main` | server tests, web typecheck and build, compose validation; then builds `ghcr.io/<owner>/<repo>/server` and `/web` (pushed on `main` as `latest`, `main` and the commit sha); a Telegram message |
| `.github/workflows/deploy.yml` | by hand (*Actions → Deploy → Run workflow*, with an image tag) | writes `.env` from `MINIAPP_ENV`, ships the compose file and both images, `docker compose up -d`, waits for `/health/ready`; a Telegram message |

### First deploy

1. **Deploy the bot, the engine and marketbot-api first.** The mini app uses the bot's Postgres and Kafka, and the engine must have started once with `EXCHANGE_ENABLED=true` so the `exchange` schema is current - `/health/ready` reports `exchange_schema` until it is.
2. **DNS:** point the app's domain (e.g. `app.parscryptoexchange.com`) at the server.
3. **marketbot-api:** add `MINIAPP_DOMAIN=app.parscryptoexchange.com` (and `MINIAPP_PORT` if `WEB_PORT` below is not 8082) to its `API_ENV` secret and redeploy it. Its nginx then serves the ACME challenge for the domain; issue the certificate once on the server, in the API's deploy directory:
   ```sh
   docker compose run --rm --entrypoint certbot certbot certonly \
     --webroot -w /var/www/certbot -d app.parscryptoexchange.com
   ```
   nginx switches the domain to HTTPS by itself within five minutes. That site allows Telegram's web clients to frame the app and passes the `/api/v1/market/ws` WebSocket through.
4. **This repo:** add the secrets and variables below, merge to `main`, wait for CI, then run *Deploy*.
5. **BotFather:** `/mybots` → the bot → *Bot Settings* → *Configure Mini App* (or *Menu Button*) → `https://app.parscryptoexchange.com`.
6. **Zarinpal:** register the same domain on the merchant account; the gateway returns the user to `$PUBLIC_URL/api/v1/payments/callback`.

With `NODE_ENV=production` (set by the prod compose file) the server refuses to start without `BOT_TOKEN`, `PUBLIC_URL`, `DB_PASSWORD`, `KAFKA_BROKERS`, `KAVENEGAR_API_KEY` and `KAVENEGAR_OTP_TEMPLATE`, and `ZARINPAL_MERCHANT_ID`, or with the console SMS or the fake gateway; `docker logs marketbot-miniapp-server` names what is missing.

### GitHub secrets and variables

*Settings → Secrets and variables → Actions.* The deploy job runs in the `production` environment, so these may live there instead (*Settings → Environments → production*), with required reviewers if you want a second pair of eyes on every deploy.

| Name | Kind | Required | Value |
|---|---|---|---|
| `SSH_HOST` | secret | yes | the server's IP or hostname |
| `SSH_USER` | secret | yes | a user on the server that can run `docker` |
| `SSH_PRIVATE_KEY` | secret | yes | private key whose public half is in that user's `~/.ssh/authorized_keys` |
| `SSH_KNOWN_HOSTS` | secret | yes | output of `ssh-keyscan -p <port> <host>`, so the runner trusts only that server |
| `MINIAPP_ENV` | secret | yes | the server's whole `.env`, multi-line - see below |
| `TELEGRAM_BOT_TOKEN` | secret | no | bot that posts CI and deploy messages; unset turns the messages off |
| `TELEGRAM_CHAT_ID_CICD` | secret | no | numeric chat ID for those messages (`-100...` for a channel) |
| `MINIAPP_DEPLOY_PATH` | variable | no | directory on the server for the compose file and `.env`, e.g. `/opt/marketbot-miniapp` (the SSH user must be able to write there); default `/opt/marketbot-miniapp` |
| `SSH_PORT` | variable | no | SSH port; default `22` |
| `BOT_USERNAME` | variable | no | bot username without `@`, baked into the web build for the "open in Telegram" link |

`GITHUB_TOKEN` is provided by Actions; it pushes and pulls the images. The SSH, `SSH_PORT` and Telegram values are the same as in the other MarketBot repos, so they can be organization-level secrets shared by all of them.

`MINIAPP_ENV` - every variable is documented in `server/.env.example`. `DB_*` must match the bot's; `DB_HOST`, `HOST`, `NODE_ENV` and the image names are set by the compose file and the workflow.

```sh
PUBLIC_URL=https://app.parscryptoexchange.com
BOT_USERNAME=your_bot
BOT_TOKEN=123456:ABC...
DB_PORT=5432
DB_USER=marketbot
DB_PASSWORD=...
DB_NAME=marketbot
SMS_PROVIDER=kavenegar
KAVENEGAR_API_KEY=...
KAVENEGAR_OTP_TEMPLATE=...
PAYMENT_PROVIDER=zarinpal
ZARINPAL_MERCHANT_ID=...
ZARINPAL_SANDBOX=false
KAFKA_BROKERS=127.0.0.1:9092
# Optional: SERVER_PORT (8090) and WEB_PORT (8082, = MINIAPP_PORT in marketbot-api)
```

### Rolling back

Run *Deploy* again with the previous commit's full sha as the image tag; every `main` build is kept under its sha.

## Layout

| Path | What it is |
|---|---|
| `server/src/app.js` | routes; `buildApp({ users, otp, wallets, ... })` so tests pass fakes |
| `server/src/store.js` | `UserStore`: sign-in, sessions, linking to the exchange account |
| `server/src/schema.js` | the `miniapp_*` tables |
| `server/src/otp.js`, `sms.js` | SMS codes; Kavenegar and the console stand-in |
| `server/src/wallets.js` | balances and ledger moves on `exchange.wallets` |
| `server/src/payments.js` | Zarinpal and the fake gateway; charges |
| `server/src/withdrawals.js` | withdrawal requests, Sheba check |
| `server/src/exchange.js`, `gen/` | the engine's Kafka bridge (from marketbot-api) and its protobufs |
| `server/src/trading.js`, `hub.js` | market data and orders; the WebSocket fan-out |
| `server/src/telegram.js` | `verifySigned()` for `initData` and shared contacts |
| `server/src/phone.js` | `normalizeIranMobile()` |
| `web/src/App.tsx` | sign-in and the SMS code, as a small state machine |
| `web/src/nav.tsx`, `screens/Shell.tsx` | tabs, pushed pages, Telegram's back button |
| `web/src/screens/` | the screens; `trade/` is the trade page |
| `web/src/live.ts`, `wallet.ts` | the WebSocket; the shared balances |
| `web/src/preview.ts` | development only: the fake server behind `?preview=` |
| `web/src/telegram.ts` | typings and helpers for `window.Telegram.WebApp` |
| `web/src/api.ts` | the server's API |
| `web/src/i18n/fa.ts` | every user-visible string |
| `web/public/fonts/` | Vazirmatn variable font (SIL OFL, `OFL.txt`) |
| `docker-compose.yml`, `*/Dockerfile` | local images; both build from the repository root |
| `docker-compose.prod.yml` | production: the CI-built images, loopback only |
| `.github/workflows/` | CI and the manual deploy; `.github/actions/telegram-notify` |
# marketbot-miniapp
