# LN Pool: design, trust model and limits

LN Pool is an LNbits WASM extension. A hall owner (an LNbits user) picks a
wallet; players open the hall link, create or join a 1v1 8-ball match, each
pay the same buy-in, play in the browser, and the winner claims the pot.

```
LNbits
├── ui/play.html + static/      the game: canvas, physics, rules, controls
│     └── lnbits-extension-sdk.js   bridge to LNbits (the frame cannot fetch)
├── ui/admin.html               hall settings, match list, manual settlement
└── wasm/module.wasm            built from dev/src/index.js
      halls · matches · players · buy-ins · turn order
      the agreed table · settlement
```

## Who decides what

| Thing | Decided by |
|---|---|
| Who sits where | The invoice-paid event from LNbits. A browser cannot seat itself. |
| Whose turn it is, which shot number | The backend. |
| What a shot does to the table | Both browsers, independently, with the same engine. |
| That a turn happened | The backend, only when both players report the same table. |
| Who won | The last agreed table, or a player conceding. |
| Who is paid, how much, how often | The backend. |

The backend never simulates pool. It treats the table as opaque JSON and reads
two fields from it, `turn` and `winner`, and only after both players sent the
identical JSON.

## One turn

```
shooter                    backend                      opponent
   │  POST /shot {seq, shot} ─▶ checks seat key, turn, seq
   │  (already animating)       stores the shot ── poke ─▶ GET, animates
   │                                                        the same shot
   │  POST /result {table} ─▶   stores it in the
   │                            shooter's row
   │                            stores it in the      ◀─ POST /result {table}
   │                            opponent's row
   │                            equal?  commit: seq+1, turn, winner
   │                            differ? status = disputed
```

Nothing waits on the network while balls roll. The shooter starts animating
on the click; the backend only records the shot's three numbers.

The shot is a direction vector, a power and (with ball in hand) a cue
position. It is not a result, so a modified client cannot claim a pot it did
not make: the other browser computes the same shot and would report
something else.

### Why two browsers agree

`static/pool-engine.js` advances in fixed 1/240 s steps and uses only
`+ - * /` and `Math.sqrt` on the simulation path, which ECMAScript specifies
exactly. A test fails if `sin`, `cos`, `hypot`, `pow` or `random` appear in
it. Resting positions are snapped to 1/1024 of a table unit, and both players
start every shot from the committed table, not from their own last frame.

Checked: 60 scripted games (2,768 shots, 1.6 million steps) give the same
digest in V8 (Node 22, Chrome) and in JavaScriptCore (Safari's engine, with
and without JIT). Firefox was not run; the argument above covers it but it is
not measured.

Each agreed table carries `engine`, the engine version. A browser holding a
different version refuses to continue the match instead of reporting a
different table. Do not upgrade the extension while matches are in play.

## Money

```
create match ─▶ buy-in invoice for seat 1, plus a 1 sat settlement lock
join         ─▶ buy-in invoice for seat 2
paid events  ─▶ seats taken; when both are, status = active
agreed winner or concession ─▶ status = finished
claim        ─▶ (a Lightning address is resolved to an invoice)
claim again  ─▶ lock taken ─▶ invoice recorded
claim again  ─▶ recorded invoice paid
```

States: `open → active → finished`, plus `open → cancelled` (the first player
cancels before anyone else pays and takes the buy-in back), `disputed`, and
`resolved` (closed by the operator).

The pot sits in the hall owner's wallet from the buy-ins until the claim.
This is custodial: players trust the hall owner with the pot for the length
of the match.

### Why there is a "settlement lock"

Extension storage is last-writer-wins. `storage.set` is an upsert, there is
no insert-if-absent and no compare-and-set, and up to four invocations of the
extension run at once. So storage cannot tell which of two simultaneous
claims came first. A design that writes "payout started" and then pays can be
raced: two players acting together, or one person in two tabs, send two
claims at the same moment, both read "not paid", both pay.

LNbits' payment layer does have an at-most-once guarantee: one BOLT11 is paid
at most once per wallet. The duplicate check runs under the wallet's payment
lock (`lnbits/core/services/payments.py`), and core tests it
(`test_pay_twice`, `test_pay_twice_fast_same_invoice`).

LN Pool turns that into a mutex. Each match gets a 1 sat invoice on the hall's
own wallet when it is created. To record the invoice a match pays out to, a
claim must first pay that 1 sat invoice from the same wallet. Exactly one
invocation succeeds. The self-payment moves no money.

Everything lives in `takeSettlementLock` in `dev/src/index.js`. It is a
stand-in for a missing primitive and is meant to be replaced.

Verified against unmodified LNbits core 1.6.2-rc1 with the fake funding
source: four simultaneous claims carrying four different invoices produced
one payout; the other three were told the match was settling.

### One recorded invoice

Settlement has one step that must not happen twice, and many that may:

- **Recording** the invoice the match pays is exclusive. The claim that takes
  the lock writes a `bound` row in `lnpool_payouts` with the invoice.
- **Paying** it is not. Any claim, any number of times, from any number of
  invocations at once, may call LNbits to pay the recorded invoice. They can
  only ever pay that one invoice, and LNbits pays an invoice at most once: a
  second call is answered "already paid" or "still pending" from the payment
  LNbits already holds, and sends nothing. That same call is how the backend
  learns how a payment ended, because the host API has no call to look a
  payment up.

Each paying call writes a row of its own before it calls (`started`) and its
answer afterwards:

| Row | Meaning | LNbits said |
|---|---|---|
| `bound` | the invoice this match pays; the row made no call | |
| `started` | a call was made and never reported: cut off, or still running | |
| `paid` | the invoice is paid | success, or "already paid" |
| `pending` | a payment of it is in flight | pending, or "still pending" |
| `refused` | this call sent nothing | an error core raises before it creates a payment: balance, routing-fee reserve, amount limit, wallet limits, background-payment grant |
| `failed` | the node tried and reported failure | "Payment failed: ..." |
| `dead` | LNbits holds a failed payment of this invoice and will never send it again | "Payment is failed node, retrying is not possible." |
| `unknown` | anything else, including an error text this code does not know | |

What the rows say about the match:

- **paid**: some call reported the invoice paid. Final.
- **bound**: an invoice is recorded and not known to be paid. It is the only
  thing the match pays, whatever destination a claim names.
- **released**: a `dead` row exists for the recorded invoice. Another invoice
  may be recorded, behind the next lock.

Nothing else releases an invoice. A `refused` call says only that this call
sent nothing; LNbits checks the balance before it looks for an earlier
payment, so it can refuse a call although a payment exists. A `started` row
without an answer may have paid. So after "the hall wallet is short" the
winner tries the same invoice again once the wallet is topped up, and cannot
switch to another wallet until LNbits itself has given up on the first one.

`dead` rests on the funding source: the node reported the payment failed when
it was sent and again when LNbits asked later, and LNbits refuses to send an
invoice it already has a payment for, which also stops any call for that
invoice that is still on its way. That is the same evidence LNbits uses to
give the money back to a wallet.

The lock a second recording needs is made ahead of time, by the paid event
that seats the second player: at that moment the match has just started and
nobody is waiting on the call. A recording that finds none (a refund, or a
match from an earlier version) makes one after its own row is safely written.

### What the pages are told

The match row keeps a copy of the outcome (`payout_status`) for pages and
lists. It is never used to decide a payout.

| Shown | Meaning | Offered to the player |
|---|---|---|
| `paying` | an invoice is recorded and being paid | nothing; the page asks again by itself |
| `pending` | LNbits has the payment in flight | the same |
| `paid` | | |
| `unsent` | every call so far was refused before sending | "Try again" (same invoice) |
| `failed` | the node reported failure | "Try the payment again"; that call asks LNbits to confirm it |
| `unconfirmed` | a payment may have been made and nothing since has been able to tell | "Check the payment again" |
| `released` | the payment failed for good | the claim form, for another invoice or address |
| `manual` | the operator has to settle | |

A refused check adds nothing to what is known, so it never turns `pending`,
`failed` or `unconfirmed` into `unsent`.

The copy cannot age by itself: when the invocation that was paying is cut
off, the row would say `paying` for ever. So the view turns `paying` into
`unconfirmed` after 15 seconds without a new answer, and `pending` after two
minutes. The page applies the same rule on its own clock (20 seconds, 150
seconds), so a page that gets no answers at all still leaves "Sending".

### The time limit, and what LNbits does with slow calls

LNbits stops an extension call after `wasm_runtime_max_execution_ms` (5 s by
default). The clock runs during host calls too. When it runs out LNbits
interrupts the guest, which shows in the log as `wasm trap: interrupt`; it
does not cancel a host call that is under way, so a payment in progress
still completes or fails on its own. LNbits also waits up to 5 s for the node
to pay an invoice.

Two more things were measured on a real instance whose funding source is
another LNbits:

- every invoice created and every payment made is a web request to that
  other instance: about a second for an invoice, 4.8 s or more for a payout;
- LNbits lets one thing at a time use its main database, and keeps it during
  some of those requests. While one is under way, calls that normally take
  milliseconds wait: a plain read of a match took 7 s.

So any call can be cut off at any point, and a payout usually is. The design
follows from that:

- **A claim is up to three calls**, each of which does one slow thing at
  most: resolve a Lightning address (two web requests, nothing recorded);
  record the invoice (the lock, three storage calls, nothing asked of the
  funding source); pay (a few storage calls, then the payment).
- **Nothing slow sits between taking the lock and writing its row.** A call
  that has already used 2.5 s does not take the lock. A lock spent with no
  row written ends automatic settlement for that match; the window is two
  storage reads wide.
- **A payment that outlives its call leaves `started`.** The next claim asks
  LNbits about the same invoice: one call, no lock, no invoice to create.
  Asked again while the first call may still be running (within 15 s), the
  backend answers "settling" without calling LNbits at all.
- **LNbits only answers "already paid" when the wallet holds the amount plus
  the reserve**, because it checks the balance first. From a wallet the payout
  emptied the check is refused; the match shows `unconfirmed` and stays bound
  until a check is made with enough in the wallet, or the operator confirms
  the payment in the wallet's list and closes the match.
- **The page makes one claim at a time**, gives a request 15 s, asks again by
  itself four times over about 80 s, then leaves a button. An earlier version
  started a new claim from every answer and reached hundreds of requests for
  one payout.

A timeout never frees an invoice. Verified on LNbits core with a node made
slower than the limit: the invoice was paid, the call was stopped, no other
destination was accepted, and four simultaneous checks made with funds in
the wallet all reported "paid" without anything being sent.

An operator can raise this extension's execution limit in LNbits (runtime
limits, for example to 15 000 ms) so that more payouts report in the call
that made them. Nothing above depends on it.

### Routing fees

The prize is what the match advertised: the pot less the hall fee. It is paid
in full or not at all; an invoice for any other amount is refused.

The hall fee is the hall's share of the pot. Routing fees are a separate
network cost, paid from the hall wallet on top of the prize. LNbits will only
send a payment when the wallet holds the amount plus a reserve for them
(`lnbits_reserve_fee_min` and `lnbits_reserve_fee_percent`: 2 sats, or 1% if
that is more, by default). A payment to a wallet on the same LNbits needs no
reserve.

So the hall wallet has to hold more than the pots, and keeping it so is the
operator's job. A hall fee helps but guarantees nothing: 10% of a 10 sat pot
is 1 sat, less than the reserve. With no fee the whole pot goes to the
winner and the wallet needs spare sats for every payout.

When the wallet holds too little, LNbits refuses before anything is sent.
The match shows `unsent`, the player is told the hall wallet needs funds,
the owner page flags the match, and after a top-up the player tries again.

The backend cannot check this beforehand: a claim runs without a user, and the
host API only shows a wallet balance to its signed-in owner.

### What the lock costs

- **1 sat invoices on the hall's funding source**: one per match, one more
  when the second player's buy-in arrives. A normal payout pays the first to
  the wallet itself and leaves the other unpaid; it expires.
- **It expires.** Core gives extension invoices the instance default expiry
  (`LIGHTNING_INVOICE_EXPIRY`, 3600 s by default) and the host API cannot set
  another. An invoice has to be recorded within that time of the match being
  created, or the claim fails with a message and the operator pays by hand.
  Paying a recorded invoice, and checking on it, need no lock and have no
  such limit.
- **A call cut off between taking the lock and writing its row** ends
  automatic settlement for that match. It fails closed.
- **It depends on error strings from core**: "already paid" and "still
  pending" to tell "someone else is recording" from "cannot record", and the
  texts in the table above. If core rewords them, payouts fail closed.
- **At most 40 calls to pay one invoice.** After that the operator settles.

### Other money rules

- A payout invoice must be for exactly the amount owed. A Lightning address
  is resolved to an invoice in a call of its own; the page sends the invoice
  back to be recorded.
- To settle by hand, the operator closes the match first (nobody can claim
  after that) and checks the wallet's payments for an outgoing "LN Pool
  payout" with the match id before paying.
- Rows written by earlier versions are read by the same rules: the invoice
  of the last recording (or of the first row, before recordings were kept
  separately) is the one the match pays. A match whose invoice an earlier
  version kept in the match row can only retry that invoice.
- Seat keys are 32 random bytes from the host. The backend keeps only the
  SHA-256, and only the hash goes into invoice metadata. The key is returned
  once to the browser that asked for the invoice, and is never put in a URL
  or a websocket message.

### Fuel

LNbits runs every extension call with a budget of 100 million units of WASM
fuel (`wasm_runtime_max_fuel`). LN Pool is built to run on that default with
room to spare. Measured through the end-to-end harness on LNbits 1.6.2-rc1,
dearest invocation of each kind:

| Call | Fuel, millions |
|---|---|
| owner list, 100 rows (the largest page the API allows) | 23 |
| owner list, 20 rows | 12 |
| lobby, 50 open matches (the most it lists) | 14 |
| claim a payout, full-size table (the paying call) | 13 (14 at most) |
| report a result (the one that commits) | 12 |
| create a match, record a shot, join, paid event | 11 |
| read a match | 10 |

About 9 million of every call is the JavaScript runtime starting up. What the
extension itself adds is small: the call that pays a claim makes 13 host
calls and spends 4 million on top of the start-up cost.

**The build toolchain decides this, and it is pinned.** The component is built
with jco 1.19.0, which uses componentize-js 0.20.0. Newer versions generate
string-passing code that counts the code points of every string leaving the
guest, in interpreted JavaScript, and never uses the count. That made every
character of every host-call argument and of the returned JSON cost about
14,600 fuel. The same source, measured on each toolchain:

| componentize-js | jco tested | start-up | per host call | per character sent |
|---|---|---|---|---|
| 0.17.0 | 1.10.2 | 6.8 M | 0.04 M | 60 |
| 0.18.5 | 1.13.3 | 7.2 M | 0.09 M | 61 |
| 0.19.3 | 1.17.7 | 9.0 M | 0.13 M | 61 |
| 0.20.0 | 1.19.0 (pinned) | 9.0 M | 0.09 M | 59 |
| 0.21.0 | 1.25.0 | 10.4 M | 1.03 M | 14,600 |
| 0.22.0 | 1.35.0 | 10.4 M | 1.03 M | 14,600 |
| 0.23.0 | none yet | 9.0 M | 0.11 M | 2,600 |

The first builds of LN Pool used jco 1.35.0. A match row is about 1,700
characters once it holds a table and two invoices, and a claim writes it
twice and returns it once, so a claim on a real match needed 117 million: it
paid the winner, recorded `paid`, and was cut off before it could answer
(HTTP 500 with the money already sent). The owner list failed above 20 rows
and the lobby reached 85 million at 50 matches. Nothing was ever paid twice,
but a claim cut off a little earlier, between taking the lock and binding the
invoice, would have left a match for the operator to settle by hand.

Do not change the jco version in `dev/package.json` without running
`dev/e2e/run.sh`. It measures the fuel of every call at the default limit and
fails if any call uses more than half of it, if a call is cut off, or if a
claim on a full-size table is not answered.

Apart from the toolchain, the backend keeps its own costs flat:

- Neither list does anything per match. The owner list is two queries (a page
  of matches, and up to 50 unseated buy-ins). The lobby is one read and one
  query that asks storage for open, paid matches only, newest first, at most
  50, so unpaid matches cannot fill it or push paid ones out.
- The host clock is read once per call.
- A claim reads the match again only where safety needs it: after taking the
  lock, and before recording what happened to the payment.

## What is not protected

Plainly:

1. **A player who is losing can stop cooperating.** If one player never
   reports a result, the turn never commits, the match stays `active`, and
   nobody is paid automatically. Nothing awards the match on a timeout,
   because a timeout rule would let a cheat win by claiming the other side
   went quiet. The operator has to step in.
2. **A player can force a dispute** by reporting a false table. They cannot
   win that way, but the match freezes. The backend keeps the table before
   the shot, the shot, and both reports; the admin page replays the shot with
   the same engine and says which report is wrong. Acting on that is manual.
3. **Aim assistance cannot be detected.** The shot is three numbers; nothing
   shows whether a person or a program chose them.
4. **Two colluding players** can agree on any result. It is their money. They
   cannot be paid more than one pot.
5. **Anyone who knows a match id can publish on its websocket channel.** The
   client treats a message as a reason to refetch, or (for the aim preview)
   as decoration. A forged message cannot move a ball or a sat. It can make
   the opponent's cue appear to point somewhere it does not, and it can make
   clients refetch.
6. **A buy-in can arrive with no seat left.** Invoices cannot be cancelled.
   Join attempts are limited to one outstanding invoice per free seat for 180
   seconds, but a slow payer can still land late. That payment is recorded as
   `unseated` and listed for the operator. Nothing refunds it automatically.
7. **A paid event that is never delivered loses a seat.** If LNbits fails to
   run the paid event (for example the extension was at its concurrency limit
   at that moment), the buy-in is in the wallet and the player has no seat.
   Core does not retry and the host API cannot look a payment up.
8. **The seat lives in one browser tab.** The key is in the host page's
   session storage. Closing the tab loses it unless the player copied it
   from the "Seat key" panel.
9. **Lost updates on a match row are possible in narrow windows.** For
   example a cancel landing at the instant the second buy-in is recorded can
   leave a cancelled match with a paid second player (manual refund). Seats
   are derived from player rows, which only the paid event writes, so a
   request can never erase a seat; and no such window can cause a second
   payout, because of the lock.
10. **The operator is trusted** with the pot, with manual settlement, and
    with not marking a match resolved wrongly.

## What the framework is missing

Things LN Pool had to work around or could not do. None of them needs a
change to this extension's structure once available.

| Missing | Effect today | With it |
|---|---|---|
| Atomic storage write (insert-if-absent, or compare-and-set) | The 1 sat settlement lock, with its expiry and extra invoice | Replace the body of `takeSettlementLock` |
| Idempotency key on `pay_invoice` (core has `external_id`; the host API does not pass it) | Same | Pay with key `match:<id>` and drop the lock |
| Invoice expiry in `create_invoice_public` | Lock dies after the default hour | Long-lived lock |
| Authenticated websocket connections / server-only events | Clients must treat every message as a hint and refetch | Pokes and the aim preview become trustworthy; the shot could travel on the socket |
| Retry of a failed paid-event dispatch, or a host call to read a payment | A dropped event loses a seat. A payout's result can only be learned by paying its invoice again, which LNbits refuses when the wallet is low | Reconcile on the next request; read the payout's status directly |
| A wallet balance readable by a public call, or a payment that can carry its own fee budget | The backend cannot tell beforehand that the hall wallet is short of the routing-fee reserve | Refuse the match, or warn the operator, before a player is owed money |
| A host call to cancel or shorten an invoice | Late buy-ins need manual refunds | No overflow |
| More fuel/time for one invocation, or a native helper | The backend cannot replay a shot itself | A referee: the backend re-runs a disputed or unreported shot with the same engine and awards the match |
| Scheduled invocations | No timeouts | Forfeit on a clock, once the referee exists |

## Layout

```
config.json                  17 exports, 16 API routes, 3 UI routes, 8 permissions
wasm/lnbits-extension.wit    the host functions imported and the exports
wasm/module.wasm             built component (jco / StarlingMonkey)
storage/                     lnpool_halls, lnpool_matches, lnpool_players, lnpool_payouts
dev/src/index.js             the backend
dev/src/lnbits-sdk.js        wrapper over the host functions
dev/scripts/bundle.mjs       concatenates the two for jco
dev/scripts/bot.mjs          a headless opponent for testing alone
dev/test/                    backend tests on a fake host; engine tests
static/pool-engine.js        physics and rules (shared by browsers, bot, tests, admin replay)
static/play.js               player page controller: talks to the backend, runs shots
static/play-ui.js            player page presentation: everything put on the page
static/pool-view.js          presentation logic with no DOM: wording, announcements, ball rotation maths
static/pool-claim.js         the requests that make up one claim, with no DOM: steps, timeout, when to ask again
static/pool-table.js         canvas renderer: table, lit rolling balls, cue, effects
static/pool-fx.js            visual-only observers of a shot: rotation, impacts, pocket drops, sound
static/sponsors.js           sponsor placements (empty by default)
static/admin.js              hall owner page
static/lnbits-extension-sdk.js   iframe bridge client
static/vendor/qrcode.js      QR generator (MIT)
ui/play.html, ui/admin.html
```

### What may touch the game, and what may not

Only `pool-engine.js` computes a table, and only `play.js` sends anything to
the backend. The other four player-page files are presentation:

- `pool-fx.js` reads ball positions and the engine's counters after each step
  and derives rotation, flashes, pocket animations and sound. It never writes
  to the simulation. A test replays shots with it attached and requires the
  same result as without.
- `pool-table.js` draws. Balls are drawn a fraction of a step ahead of the
  simulation for smooth motion; that offset exists only in the drawing.
- `pool-view.js` and `play-ui.js` turn state into words and elements.

`pool-engine.js` has a test that fails if `sin`, `cos`, `hypot`, `pow` or
`random` appear in it. The presentation files are free to use them.

### Sponsor places

Three places are reserved and hidden: a strip at the bottom of the lobby, a
strip under the table, and a faint line of text on the cloth. They appear
only if `static/sponsors.js` names a sponsor. Text and, optionally, an image
shipped inside the extension; no links, no requests, no tracking.

Storage rows and who writes them:

| Row | Written by |
|---|---|
| `lnpool_halls` | the owner, on save |
| `lnpool_matches` | create; the seat refresh while `open`; shot, commit, concede while `active`; cancel; the lock holder and its retries; the operator's resolve |
| `lnpool_players` | join (pending row); the paid event (seat); that player's own result reports |
