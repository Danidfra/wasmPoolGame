# LN Pool

1v1 8-ball pool for sats, as an LNbits WASM extension. A hall owner picks a
wallet and shares a link. A player creates a match and chooses the stake, an
opponent joins, both pay the same buy-in, they play in the browser, and the
winner claims the pot to a Lightning address or an invoice.

- Extension id `lnpool`, type `wasm`, minimum LNbits 1.5.7 (developed on 1.6.2-rc1)
- Owner page: `/ext/lnpool`
- Hall (public): `/ext/lnpool/halls/{hall_id}`
- Match (public): `/ext/lnpool/matches/{match_id}`

How it works, what it protects and what it does not: [docs/DESIGN.md](docs/DESIGN.md).
What is reused from other projects: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## The short version of the trust model

- A match starts only after LNbits reports both buy-ins paid.
- A shot is sent as input (direction, power, cue position). Both browsers
  simulate it with the same deterministic engine, and a turn counts only when
  both report the same table. Different reports freeze the match.
- The pot is paid at most once, to an invoice for exactly the amount owed. If
  a payout is not sent, the winner can claim again; another destination is
  accepted only when LNbits has shown that the first one was never paid.
- It is custodial: the hall owner's wallet holds the pot during the match.
- It is not an anti-cheat. A losing player can stall or force a dispute, and
  those cases are settled by the hall owner by hand.

## Build and test

```bash
cd dev
npm run check        # syntax checks + 78 tests (backend on a fake host, engine, page logic)
npm run build:wasm   # bundle + jco componentize -> ../wasm/module.wasm
e2e/run.sh           # 73 checks against your LNbits checkout, on a throwaway data folder
```

`build:wasm` needs network access the first time (npx fetches jco 1.19.0).
The jco version is pinned on purpose: newer ones produce a component that
uses about ten times the WASM fuel and runs out of LNbits' default budget
when a prize is claimed. `e2e/run.sh` measures fuel and fails if that comes
back. See "Fuel" in the design notes.
Rebuild after changing anything under `dev/src/`. Changes under `static/` or
`ui/` need only a page reload. Changes to `config.json` or `storage/` need an
LNbits restart.

## Run it locally

LNbits loads every folder under `data/wasm_extensions/` at startup.

```bash
ln -s ~/Developer/lnpool ~/Developer/lnbits-work/lnbits/data/wasm_extensions/lnpool
cd ~/Developer/lnbits-work/lnbits && uv run lnbits     # restart if it was running
```

The funding source has to be able to create invoices (`VoidWallet` cannot).
For play money, start LNbits with `LNBITS_BACKEND_WALLET_CLASS=FakeWallet`.

1. Open `http://localhost:9000/ext/lnpool`. Choose the wallet, tick "Open for
   new matches", Save, and allow the background-payment prompt (winners are
   paid without you clicking, up to twice the largest stake).
2. Copy the hall link and open it. Create a match and pay the invoice.
3. Send the match link to the opponent, or play against the bot:

   ```bash
   cd dev
   node scripts/bot.mjs http://localhost:9000/ext/lnpool/matches/<match_id>
   ```

   The bot prints its own buy-in invoice; pay that too and the match starts.
4. Click or drag on the table to aim, arrow keys for fine aim, set the power,
   Shoot (or Space). With ball in hand, drag the cue ball first. On a phone
   held upright the table is turned on its end.
5. When someone wins (or concedes), the winner enters a Lightning address or
   an invoice for the exact prize and is paid.

## Rules

Seat 1 breaks. The table is open until the first legal pot after the break,
and the first ball down decides the groups. Pot your own to keep shooting.
Potting the cue ball, hitting nothing, or hitting the wrong ball first is a
foul and gives the other player ball in hand anywhere. The 8 wins once your
group is cleared, if you hit it first and do not foul; potted any other way it
loses. An 8 potted on the break is put back. No called pockets and no
rail-after-contact rule.

## For the hall owner

- Keep a float in the wallet, or set a hall fee. Routing fees for payouts are
  paid from the wallet on top of the prize, and LNbits only sends a payout
  when the wallet holds the prize plus a reserve for them (by default 2 sats,
  or 1% of the payout if that is more). A hall fee of 1% or more leaves that
  in the wallet once it comes to 2 sats; with a smaller fee or small stakes
  you need the float. A payout the wallet cannot cover is not sent: the match
  shows "NOT SENT" on the owner page, and the winner can claim again once you
  have added funds.
- A match must be claimed within the LNbits invoice expiry (one hour by
  default) of being created, or it has to be paid by hand. See "What the lock
  costs" in the design notes.
- The owner page lists buy-ins that arrived with no seat left, and matches
  that are disputed or whose payout did not go through, with every payout
  attempt and what LNbits answered. To settle one by hand: "Mark as settled
  by hand" first (that stops any further claim), check the wallet's payments
  for an outgoing "LN Pool payout" with that match id, and pay only if there
  is none or it failed.
- After a payout that did not go through, the next claim has to come within
  the LNbits invoice expiry (one hour by default) of the last one.
- Do not upgrade the extension while matches are in play.
- LNbits' default runtime limits are enough. The dearest call uses under a
  quarter of the default fuel budget. See "Fuel" in the design notes.
- `static/sponsors.js` fills the reserved sponsor places (lobby strip, strip
  under the table, a line on the cloth). It is empty by default.
