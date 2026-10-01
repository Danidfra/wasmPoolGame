"""End-to-end check of the built lnpool component inside a real LNbits app.

Run it through run.sh. It boots LNbits core from your checkout, unmodified,
against a throwaway data folder with the FakeWallet funding source and lnpool
symlinked into wasm_extensions, then drives the extension through its real
HTTP routes: buy-ins paid between wallets on that instance, the paid event,
turns computed by the browser engine, settlement, and four claims racing for
one pot. It then repeats the money paths on a full-size table, fills the lobby
and the owner list, pays out to invoices from outside this LNbits (where the
routing-fee reserve applies) from a wallet that cannot cover it, and measures
the fuel of every call, all at LNbits' default fuel limit. Nothing in your
real LNbits data folder is read or written.
"""
import asyncio
import json
import os
import secrets
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ["LNPOOL_E2E_WORK"]
os.environ.update(
    {
        "LNBITS_DATA_FOLDER": os.path.join(WORK, "data"),
        "LNBITS_EXTENSIONS_PATH": os.path.join(WORK, "extroot"),
        "LNBITS_BACKEND_WALLET_CLASS": "FakeWallet",
        "LNBITS_EXTENSIONS_DEFAULT_INSTALL": "",
        "LNBITS_ADMIN_UI": "true",
        "AUTH_HTTPS_ONLY": "false",
        "DEBUG": "false",
        "ENABLE_LOG_TO_FILE": "false",
        # The harness makes several hundred requests in a few seconds.
        "LNBITS_RATE_LIMIT_NO": "100000",
    }
)

sys.dont_write_bytecode = True  # keep the extension folder free of __pycache__
sys.path.insert(0, HERE)
import fuelprobe  # noqa: E402

FUEL_MEASURED = fuelprobe.install()
DEFAULT_FUEL = 100_000_000  # LNbits' default budget for one call
FUEL_BUDGET = DEFAULT_FUEL // 2  # what any lnpool call may use: half of it

from asgi_lifespan import LifespanManager  # noqa: E402
from bolt11 import decode as bolt11_decode  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from lnbits.app import create_app  # noqa: E402
from lnbits.core.crud import create_wallet, get_wallet  # noqa: E402
from lnbits.core.models.users import UpdateSuperuserPassword  # noqa: E402
from lnbits.core.services import create_user_account, update_wallet_balance  # noqa: E402
from lnbits.core.services.payments import create_invoice, pay_invoice  # noqa: E402
from lnbits.core.views.auth_api import first_install  # noqa: E402
from lnbits.core.wasm_ext.storage.crud import _table_ref_for_schema  # noqa: E402
from lnbits.db import Database  # noqa: E402
from lnbits.settings import settings  # noqa: E402
from lnbits.wallets import get_funding_source  # noqa: E402

# The throwaway instance needs a superuser; nobody ever logs in as it.
SUPERUSER_PASSWORD = secrets.token_urlsafe(16)

checks = []


def check(name, condition, detail=""):
    checks.append((name, bool(condition)))
    print(("  ok   " if condition else "  FAIL ") + name + (f"  [{detail}]" if detail else ""))


async def main():
    app = create_app()
    # The harness identifies LNbits users by id, as the core test suite does.
    settings.auth_allowed_methods = ["user-id-only", "username-password"]
    async with LifespanManager(app, startup_timeout=60) as manager:
        settings.first_install = True
        await first_install(
            UpdateSuperuserPassword(
                username="superadmin",
                password=SUPERUSER_PASSWORD,
                password_repeat=SUPERUSER_PASSWORD,
                first_install_token=settings.first_install_token,
            )
        )
        # A call the runtime cuts off must show up as a failed check, not end the run.
        transport = ASGITransport(app=manager.app, raise_app_exceptions=False)
        async with AsyncClient(transport=transport, base_url="http://lnbits.test") as http:
            await scenario(http)


timings = []


async def api(http, method, path, body=None, usr=None):
    started = time.perf_counter()
    response = await http.request(method, "/api/v1/ext/lnpool" + path, json=body, params={"usr": usr} if usr else None)
    timings.append((time.perf_counter() - started) * 1000)
    try:
        data = response.json()
    except ValueError:
        data = response.text[:200]
    if response.status_code != 200:
        return {"ok": False, "error": f"HTTP {response.status_code}: {data}"}
    # A claim is two calls, as the page makes them: the first records the
    # invoice, the second pays it.
    if path.endswith("/claim") and data.get("ok") and data["data"].get("bound"):
        return await api(http, method, path, body, usr)
    return data


async def ok(http, method, path, body=None, usr=None):
    result = await api(http, method, path, body, usr)
    assert result.get("ok") is True, f"{method} {path} -> {result}"
    return result["data"]


async def wait_for(predicate, what, tries=100):
    for _ in range(tries):
        value = await predicate()
        if value:
            return value
        await asyncio.sleep(0.1)
    raise AssertionError("timed out waiting for " + what)


async def scenario(http):
    print("LNbits", settings.version, "funding source", settings.lnbits_backend_wallet_class)

    # --- operator -----------------------------------------------------------
    stranger = await create_user_account()
    ana_id_placeholder = (await create_wallet(user_id=stranger.id, wallet_name="not the owner's")).id
    owner = await create_user_account()
    hall_wallet = await create_wallet(user_id=owner.id, wallet_name="hall")
    await update_wallet_balance(wallet=hall_wallet, amount=50)  # a small float
    response = await http.put("/api/v1/extension/lnpool/enable", params={"usr": owner.id})
    check("extension auto-installed from the symlinked folder and enabled for the owner", response.status_code == 200, response.text[:120])

    wallets = await ok(http, "GET", "/wallets", usr=owner.id)
    check("owner route lists the owner's wallets", hall_wallet.id in [w["id"] for w in wallets["wallets"]] and ana_id_placeholder not in [w["id"] for w in wallets["wallets"]])
    anonymous = await http.get("/api/v1/ext/lnpool/hall")
    check("owner routes refuse anonymous callers", anonymous.status_code in (401, 403), str(anonymous.status_code))

    foreign_wallet = await api(http, "PUT", "/hall", {"enabled": True, "walletId": ana_id_placeholder, "walletName": "x"}, usr=owner.id)
    check("a hall cannot be pointed at someone else's wallet", foreign_wallet.get("ok") is False, foreign_wallet.get("error", "")[:40])
    hall = (await ok(http, "PUT", "/hall", {"enabled": True, "walletId": hall_wallet.id, "walletName": "hall", "minStake": 100, "maxStake": 5000, "feePercent": 0}, usr=owner.id))["hall"]
    check("hall saved", hall["enabled"] and hall["id"].startswith("hall_"), hall["id"])

    # --- two players, each with a wallet on this LNbits ----------------------
    players = []
    for name in ("ana", "bo"):
        user = await create_user_account()
        wallet = await create_wallet(user_id=user.id, wallet_name=name)
        await update_wallet_balance(wallet=wallet, amount=10000)
        players.append(wallet)
    ana, bo = players

    async def balance(wallet):
        return (await get_wallet(wallet.id)).balance

    async def new_match(stake=1000):
        created = await ok(http, "POST", f"/halls/{hall['id']}/matches", {"name": "Ana", "stake": stake})
        match_id = created["match"]["id"]
        path = f"/matches/{match_id}"
        await pay_invoice(wallet_id=ana.id, payment_request=created["paymentRequest"])
        await wait_for(lambda: seat_paid(http, path, 0), "seat 1 to be paid")
        joined = await ok(http, "POST", path + "/join", {"name": "Bo"})
        await pay_invoice(wallet_id=bo.id, payment_request=joined["paymentRequest"])
        await wait_for(lambda: status_is(http, path, "active"), "match to start")
        creds = {1: {"playerId": created["playerId"], "token": created["token"]}, 2: {"playerId": joined["playerId"], "token": joined["token"]}}
        return match_id, path, creds

    async def finish(path, creds, winner):
        view = (await ok(http, "GET", path))["match"]
        shooter = creds[view["turn"]]
        await ok(http, "POST", path + "/shot", {**shooter, "seq": view["seq"], "shot": {"dx": -1, "dy": 0, "power": 50, "place": None}})
        result = {"balls": [], "turn": winner, "groups": 0, "inHand": False, "breaking": False, "winner": winner, "shots": view["seq"] + 1, "last": None}
        await ok(http, "POST", path + "/result", {**creds[1], "seq": view["seq"], "result": result})
        return (await ok(http, "POST", path + "/result", {**creds[2], "seq": view["seq"], "result": result}))["match"]

    # --- create, pay, join, pay ---------------------------------------------
    hall_before = await balance(hall_wallet)
    created = await ok(http, "POST", f"/halls/{hall['id']}/matches", {"name": "Ana", "stake": 1000})
    match_id = created["match"]["id"]
    path = f"/matches/{match_id}"
    check("public create returns a seat key and a BOLT11", len(created["token"]) == 64 and created["paymentRequest"].startswith("ln"))
    check("match is open and unpaid", created["match"]["status"] == "open" and not created["match"]["seats"][0]["paid"])
    lobby = await ok(http, "GET", f"/halls/{hall['id']}")
    check("unpaid match is not in the lobby", lobby["matches"] == [])

    await pay_invoice(wallet_id=ana.id, payment_request=created["paymentRequest"])
    await wait_for(lambda: seat_paid(http, path, 0), "seat 1 to be paid")
    check("paid event seated player 1 (real invoice-paid dispatch)", True)
    lobby = await ok(http, "GET", f"/halls/{hall['id']}")
    check("paid match is listed in the lobby", [m["id"] for m in lobby["matches"]] == [match_id])

    joined = await ok(http, "POST", path + "/join", {"name": "Bo"})
    busy = await api(http, "POST", path + "/join", {"name": "Cy"})
    check("second join attempt is held off while the first invoice is outstanding", busy.get("ok") is False, busy.get("error", "")[:60])
    await pay_invoice(wallet_id=bo.id, payment_request=joined["paymentRequest"])
    await wait_for(lambda: status_is(http, path, "active"), "match to start")
    check("match became active only after both buy-ins settled", True)
    check("hall wallet holds both stakes", await balance(hall_wallet) == hall_before + 2000, str(await balance(hall_wallet)))

    creds = {1: {"playerId": created["playerId"], "token": created["token"]}, 2: {"playerId": joined["playerId"], "token": joined["token"]}}
    me = (await ok(http, "POST", path + "/sync", creds[2]))["match"]
    check("seat key identifies seat 2", me["you"]["seat"] == 2 and me["you"]["status"] == "seated")
    forged = await api(http, "POST", path + "/sync", {"playerId": creds[2]["playerId"], "token": "ab" * 32})
    check("a wrong seat key is refused", forged.get("ok") is False, forged.get("error", "")[:50])

    # --- real shots computed by the browser engine ---------------------------
    turns = json.loads(subprocess.run(["node", os.path.join(HERE, "shots.mjs"), match_id], capture_output=True, text=True, check=True).stdout)
    for index, turn in enumerate(turns):
        view = (await ok(http, "GET", path))["match"]
        shooter = view["turn"]
        wrong = await api(http, "POST", path + "/shot", {**creds[3 - shooter], "seq": view["seq"], "shot": turn["shot"]})
        check(f"shot {index + 1}: the player not on turn cannot shoot", wrong.get("ok") is False)
        recorded = (await ok(http, "POST", path + "/shot", {**creds[shooter], "seq": view["seq"], "shot": turn["shot"]}))["match"]
        check(f"shot {index + 1}: shot numbers survive the round trip exactly", json.dumps(recorded["shot"]["shot"]) == json.dumps(turn["shot"]))
        half = (await ok(http, "POST", path + "/result", {**creds[1], "seq": view["seq"], "result": turn["result"]}))["match"]
        check(f"shot {index + 1}: one report does not commit", half["seq"] == view["seq"])
        done = (await ok(http, "POST", path + "/result", {**creds[2], "seq": view["seq"], "result": turn["result"]}))["match"]
        check(f"shot {index + 1}: two equal reports commit", done["seq"] == view["seq"] + 1 and done["turn"] == turn["result"]["turn"])
        check(f"shot {index + 1}: the stored table is exactly what the engine produced", json.dumps(done["game"]) == json.dumps(turn["result"]), f"{len(json.dumps(done['game']))} bytes")

    # --- finish and settle ---------------------------------------------------
    finished = await finish(path, creds, 1)
    check("agreed winning result finishes the match", finished["status"] == "finished" and finished["winner"] == 1 and finished["settlement"]["amount"] == 2000)

    loser_invoice = await create_invoice(wallet_id=bo.id, amount=2000, memo="not yours")
    stolen = await api(http, "POST", path + "/claim", {**creds[2], "destination": loser_invoice.bolt11})
    check("the loser cannot claim", stolen.get("ok") is False, stolen.get("error", "")[:50])
    too_much = await create_invoice(wallet_id=ana.id, amount=2500, memo="greedy")
    greedy = await api(http, "POST", path + "/claim", {**creds[1], "destination": too_much.bolt11})
    check("an invoice for the wrong amount is refused", greedy.get("ok") is False, greedy.get("error", "")[:50])

    no_grant = await api(http, "POST", path + "/claim", {**creds[1], "destination": (await create_invoice(wallet_id=ana.id, amount=2000, memo="early")).bolt11})
    check("without the owner's background-payment grant nothing is paid", no_grant.get("ok") is False and "not available" in no_grant.get("error", ""), no_grant.get("error", "")[:90])
    check("...and the hall wallet is untouched", await balance(hall_wallet) == hall_before + 2000)

    grant = await http.post("/api/v1/extension/lnpool/permissions/background-payment", params={"usr": owner.id}, json={"wallet_id": hall_wallet.id, "max_amount": 10000, "destination_policy": "external_allowed"})
    check("owner grants background payments", grant.status_code == 200, grant.text[:100])

    ana_before = await balance(ana)
    prize = await create_invoice(wallet_id=ana.id, amount=2000, memo="prize")
    paid = await ok(http, "POST", path + "/claim", {**creds[1], "destination": prize.bolt11})
    check("winner's claim is paid", paid["match"]["settlement"]["status"] == "paid", paid["match"]["settlement"]["status"])
    check("winner received exactly the pot", await balance(ana) == ana_before + 2000, str(await balance(ana) - ana_before))
    check("hall wallet paid the pot once (lock self-payment nets to zero)", await balance(hall_wallet) == hall_before, str(await balance(hall_wallet) - hall_before))

    second = await create_invoice(wallet_id=ana.id, amount=2000, memo="again")
    again = await ok(http, "POST", path + "/claim", {**creds[1], "destination": second.bolt11})
    check("claiming again pays nothing more", again["match"]["settlement"]["status"] == "paid" and await balance(ana) == ana_before + 2000)

    # --- the race the lock exists for ---------------------------------------
    match2, path2, creds2 = await new_match()
    await finish(path2, creds2, 2)
    bo_before = await balance(bo)
    hall_mid = await balance(hall_wallet)
    invoices = [await create_invoice(wallet_id=bo.id, amount=2000, memo=f"race {n}") for n in range(4)]
    results = await asyncio.gather(*[api(http, "POST", path2 + "/claim", {**creds2[2], "destination": inv.bolt11}) for inv in invoices])
    summary = [("settling" if r.get("data", {}).get("settling") else r["data"]["match"]["settlement"]["status"]) if r.get("ok") else "error: " + r.get("error", "")[:60] for r in results]
    await asyncio.sleep(0.5)
    final = (await ok(http, "POST", path2 + "/claim", {**creds2[2], "destination": invoices[0].bolt11}))["match"]
    check("4 simultaneous claims with 4 different invoices: one pot paid", await balance(bo) == bo_before + 2000 and await balance(hall_wallet) == hall_mid - 2000, f"{summary}, bo +{await balance(bo) - bo_before}")
    check("...and the match ends up paid", final["settlement"]["status"] == "paid")

    # --- cancel and refund ---------------------------------------------------
    created3 = await ok(http, "POST", f"/halls/{hall['id']}/matches", {"name": "Ana", "stake": 500})
    path3 = f"/matches/{created3['match']['id']}"
    creds3 = {"playerId": created3["playerId"], "token": created3["token"]}
    early = await api(http, "POST", path3 + "/cancel", creds3)
    check("an unpaid creator cannot cancel (nothing to refund)", early.get("ok") is False)
    await pay_invoice(wallet_id=ana.id, payment_request=created3["paymentRequest"])
    await wait_for(lambda: seat_paid(http, path3, 0), "seat 1 to be paid")
    cancelled = (await ok(http, "POST", path3 + "/cancel", creds3))["match"]
    check("creator cancels before anyone joins", cancelled["status"] == "cancelled" and cancelled["settlement"] == {"seat": 1, "amount": 500, "reason": "refund", "status": ""})
    ana_before = await balance(ana)
    refund = await create_invoice(wallet_id=ana.id, amount=500, memo="refund")
    refunded = await ok(http, "POST", path3 + "/claim", {**creds3, "destination": refund.bolt11})
    check("the buy-in is refunded once", refunded["match"]["settlement"]["status"] == "paid" and await balance(ana) == ana_before + 500)

    # --- dispute -------------------------------------------------------------
    match4, path4, creds4 = await new_match()
    view = (await ok(http, "GET", path4))["match"]
    await ok(http, "POST", path4 + "/shot", {**creds4[1], "seq": 0, "shot": {"dx": -1, "dy": 0, "power": 50, "place": None}})
    base = {"balls": [], "groups": 0, "inHand": False, "breaking": False, "shots": 1, "last": None}
    await ok(http, "POST", path4 + "/result", {**creds4[1], "seq": 0, "result": {**base, "turn": 1, "winner": 1}})
    disputed = (await ok(http, "POST", path4 + "/result", {**creds4[2], "seq": 0, "result": {**base, "turn": 2, "winner": 0}}))["match"]
    check("conflicting reports freeze the match", disputed["status"] == "disputed")
    cheat = await api(http, "POST", path4 + "/claim", {**creds4[1], "destination": (await create_invoice(wallet_id=ana.id, amount=2000, memo="cheat")).bolt11})
    check("a disputed match pays nobody", cheat.get("ok") is False)

    # --- operator views ------------------------------------------------------
    listing = await ok(http, "GET", "/matches", usr=owner.id)
    check("operator sees all matches", listing["total"] == 4, str(listing["total"]))
    detail = await ok(http, "GET", f"/matches/{match4}/admin", usr=owner.id)
    check("operator gets the evidence for the disputed shot", detail["evidence"]["shot"]["seq"] == 0 and len(detail["evidence"]["reports"]) == 2)
    resolved = await ok(http, "POST", f"/matches/{match4}/resolve", {"note": "refunded both by hand"}, usr=owner.id)
    check("operator can close a match by hand", resolved["match"]["status"] == "resolved")
    other_owner = await create_user_account()
    await http.put("/api/v1/extension/lnpool/enable", params={"usr": other_owner.id})
    foreign = await ok(http, "GET", "/matches", usr=other_owner.id)
    check("another LNbits user sees none of this hall's matches", foreign["total"] == 0)
    peek = await api(http, "GET", f"/matches/{match4}/admin", usr=other_owner.id)
    check("...and cannot open its admin detail", peek.get("ok") is False)

    # --- scale and fuel ------------------------------------------------------
    # Everything above once passed on a build that still ran out of fuel in
    # real use: the winning table above is nearly empty, a real one is not,
    # and lists grow. So the same paths again at real size, with LNbits'
    # default fuel limit and every call measured.
    check("LNbits is running with its default fuel limit", settings.wasm_runtime_max_fuel == DEFAULT_FUEL, str(settings.wasm_runtime_max_fuel))

    async def finish_full_table(path, creds, match_id, winner):
        """Real engine turns, then a win on a table with all its balls still described."""
        turns = json.loads(subprocess.run(["node", os.path.join(HERE, "shots.mjs"), match_id], capture_output=True, text=True, check=True).stdout)
        for turn in turns:
            view = (await ok(http, "GET", path))["match"]
            await ok(http, "POST", path + "/shot", {**creds[view["turn"]], "seq": view["seq"], "shot": turn["shot"]})
            for seat in (1, 2):
                await ok(http, "POST", path + "/result", {**creds[seat], "seq": view["seq"], "result": turn["result"]})
        view = (await ok(http, "GET", path))["match"]
        final = {**turns[-1]["result"], "winner": winner, "turn": winner, "shots": view["seq"] + 1}
        await ok(http, "POST", path + "/shot", {**creds[view["turn"]], "seq": view["seq"], "shot": turns[0]["shot"]})
        await ok(http, "POST", path + "/result", {**creds[1], "seq": view["seq"], "result": final})
        return (await ok(http, "POST", path + "/result", {**creds[2], "seq": view["seq"], "result": final}))["match"]

    def fuel_of(export):
        call = fuelprobe.last(export)
        return f"{call['total'] / 1e6:.1f}M fuel, {len(call['steps']) - 1} host calls" if call else "not measured"

    match5, path5, creds5 = await new_match()
    full = await finish_full_table(path5, creds5, match5, 1)
    table_bytes = len(json.dumps(full["game"]))
    check("a match finishes on a full-size table", full["status"] == "finished" and table_bytes > 600, f"{table_bytes} bytes, commit {fuel_of('report-lnpool-result')}")
    ana_before = await balance(ana)
    hall_mid = await balance(hall_wallet)
    prize = await create_invoice(wallet_id=ana.id, amount=2000, memo="prize on a full table")
    claimed = await api(http, "POST", path5 + "/claim", {**creds5[1], "destination": prize.bolt11})
    claim_call = fuelprobe.last("claim-lnpool-payout")
    check("a claim on a full-size table is paid and answered in one call", claimed.get("ok") is True and claimed["data"]["match"]["settlement"]["status"] == "paid", fuel_of("claim-lnpool-payout") if claimed.get("ok") else claimed.get("error", "")[:80])
    check("...for exactly the pot, once", await balance(ana) == ana_before + 2000 and await balance(hall_wallet) == hall_mid - 2000)

    match6, path6, creds6 = await new_match()
    await finish_full_table(path6, creds6, match6, 2)
    bo_before = await balance(bo)
    hall_mid = await balance(hall_wallet)
    invoices = [await create_invoice(wallet_id=bo.id, amount=2000, memo=f"full race {n}") for n in range(4)]
    results = await asyncio.gather(*[api(http, "POST", path6 + "/claim", {**creds6[2], "destination": inv.bolt11}) for inv in invoices])
    summary = [("settling" if r["data"].get("settling") else r["data"]["match"]["settlement"]["status"]) if r.get("ok") else "error: " + r.get("error", "")[:60] for r in results]
    await asyncio.sleep(0.5)
    final = (await ok(http, "POST", path6 + "/claim", {**creds6[2], "destination": invoices[0].bolt11}))["match"]
    check("4 simultaneous claims on a full-size table: every call answered, one pot paid", all(r.get("ok") for r in results) and final["settlement"]["status"] == "paid" and await balance(bo) == bo_before + 2000 and await balance(hall_wallet) == hall_mid - 2000, f"{summary}, bo +{await balance(bo) - bo_before}")

    # The lobby: more paid open matches than it lists, then a flood of unpaid
    # ones created after them.
    lobby_paid = []
    for n in range(55):
        opened = await ok(http, "POST", f"/halls/{hall['id']}/matches", {"name": f"Waiting player {n:02d}", "stake": 100 + n})
        await pay_invoice(wallet_id=ana.id, payment_request=opened["paymentRequest"])
        await wait_for(lambda: seat_paid(http, f"/matches/{opened['match']['id']}", 0), "seat 1 to be paid")
        lobby_paid.append(opened["match"]["id"])
    for n in range(60):
        await ok(http, "POST", f"/halls/{hall['id']}/matches", {"name": "Nobody", "stake": 100})
    lobby = await api(http, "GET", f"/halls/{hall['id']}")
    listed = [m["id"] for m in lobby["data"]["matches"]] if lobby.get("ok") else []
    check("lobby with 55 paid and 60 newer unpaid open matches lists 50 paid ones", len(listed) == 50 and set(listed) <= set(lobby_paid), fuel_of("get-public-lnpool-hall") if lobby.get("ok") else lobby.get("error", "")[:80])

    # The owner list, page by page and at the largest page the API allows.
    total = 2 + 2 + 2 + 55 + 60  # matches 1 to 4, the two full-size ones, the lobby
    first = await api(http, "GET", "/matches?page=1&rowsPerPage=20", usr=owner.id)
    check(f"owner list of {total} matches: a page of 20", first.get("ok") is True and len(first["data"]["matches"]) == 20 and first["data"]["total"] == total, fuel_of("list-lnpool-matches") if first.get("ok") else first.get("error", "")[:80])
    seen = set()
    for page in range(1, total // 20 + 2):
        seen.update(m["id"] for m in (await ok(http, "GET", f"/matches?page={page}&rowsPerPage=20", usr=owner.id))["matches"])
    check("...paging through it reaches every match", len(seen) == total, str(len(seen)))
    biggest = await api(http, "GET", "/matches?page=1&rowsPerPage=100", usr=owner.id)
    check("...and the largest page (100 rows) fits in one call", biggest.get("ok") is True and len(biggest["data"]["matches"]) == 100, fuel_of("list-lnpool-matches") if biggest.get("ok") else biggest.get("error", "")[:80])

    # --- real Lightning: the routing-fee reserve, and recovering from it ------
    # Everything above pays invoices of wallets on this LNbits, which cost no
    # routing fee. A payout to an outside wallet needs the prize plus LNbits'
    # fee reserve in the hall wallet. This is the first real-money test again:
    # stakes of 5, a 10% fee, a hall wallet holding nothing but the pot.
    funding = get_funding_source()

    async def outside_invoice(amount, memo):
        """An invoice the funding source can pay but that no wallet here owns."""
        bolt11 = (await funding.create_invoice(amount=amount, memo=memo)).payment_request
        return bolt11, bolt11_decode(bolt11).payment_hash

    tight_owner = await create_user_account()
    tight_wallet = await create_wallet(user_id=tight_owner.id, wallet_name="hall with no float")
    await http.put("/api/v1/extension/lnpool/enable", params={"usr": tight_owner.id})
    tight = (await ok(http, "PUT", "/hall", {"enabled": True, "walletId": tight_wallet.id, "walletName": "tight", "minStake": 5, "maxStake": 5000, "feePercent": 10}, usr=tight_owner.id))["hall"]
    await http.post("/api/v1/extension/lnpool/permissions/background-payment", params={"usr": tight_owner.id}, json={"wallet_id": tight_wallet.id, "max_amount": 10000, "destination_policy": "external_allowed"})

    async def tight_match(stake):
        created = await ok(http, "POST", f"/halls/{tight['id']}/matches", {"name": "Ana", "stake": stake})
        path = f"/matches/{created['match']['id']}"
        await pay_invoice(wallet_id=ana.id, payment_request=created["paymentRequest"])
        await wait_for(lambda: seat_paid(http, path, 0), "seat 1 to be paid")
        joined = await ok(http, "POST", path + "/join", {"name": "Bo"})
        await pay_invoice(wallet_id=bo.id, payment_request=joined["paymentRequest"])
        await wait_for(lambda: status_is(http, path, "active"), "match to start")
        creds = {1: {"playerId": created["playerId"], "token": created["token"]}, 2: {"playerId": joined["playerId"], "token": joined["token"]}}
        return created["match"]["id"], path, creds

    match7, path7, creds7 = await tight_match(5)
    won = await finish(path7, creds7, 1)
    check("5 sat stakes at a 10% fee: the prize is 9, and the hall wallet holds exactly the pot", won["settlement"]["amount"] == 9 and await balance(tight_wallet) == 10, str(await balance(tight_wallet)))
    first, first_hash = await outside_invoice(9, "first wallet")
    refused = await api(http, "POST", path7 + "/claim", {**creds7[1], "destination": first})
    refused_view = refused["data"]["match"]["settlement"] if refused.get("ok") else {"status": refused.get("error")}
    check("the payout is refused by LNbits for want of a routing-fee reserve, and reported as not sent", refused_view["status"] == "refused" and "reserve at least (2" in refused_view.get("detail", ""), f"{refused_view['status']}: {refused_view.get('detail', '')[:90]}")
    check("...nothing left the hall wallet", await balance(tight_wallet) == 10 and first_hash not in funding.paid_invoices, str(await balance(tight_wallet)))
    second, second_hash = await outside_invoice(9, "second wallet")
    again = (await ok(http, "POST", path7 + "/claim", {**creds7[1], "destination": second}))["match"]
    check("claiming again while the wallet is short is refused again, and binds nothing", again["settlement"]["status"] == "refused" and await balance(tight_wallet) == 10 and second_hash not in funding.paid_invoices)
    detail = await ok(http, "GET", f"/matches/{match7}/admin", usr=tight_owner.id)
    check("the operator sees the match flagged and both attempts", detail["match"]["payoutStatus"] == "refused" and [p["status"] for p in detail["payouts"]] == ["bound", "refused", "bound", "refused"], str([p["status"] for p in detail["payouts"]]))

    await update_wallet_balance(wallet=tight_wallet, amount=2)  # the operator tops up
    third, third_hash = await outside_invoice(9, "third wallet")
    paid = (await ok(http, "POST", path7 + "/claim", {**creds7[1], "destination": third}))["match"]
    check("after a top-up of 2 sats the full prize is paid, to a new destination", paid["settlement"]["status"] == "paid" and third_hash in funding.paid_invoices, paid["settlement"]["status"])
    check("...once: the hall wallet is down by exactly 9, the refused invoices were never paid", await balance(tight_wallet) == 3 and first_hash not in funding.paid_invoices and second_hash not in funding.paid_invoices, str(await balance(tight_wallet)))
    late = (await ok(http, "POST", path7 + "/claim", {**creds7[1], "destination": first}))["match"]
    check("claiming again with the first invoice pays nothing more", late["settlement"]["status"] == "paid" and await balance(tight_wallet) == 3 and first_hash not in funding.paid_invoices)

    # The race again, at the point the new rule opens up: after a refusal,
    # four claims at once, each naming a different outside wallet.
    await ok(http, "PUT", "/hall", {"enabled": True, "walletId": tight_wallet.id, "walletName": "tight", "minStake": 5, "maxStake": 5000, "feePercent": 0}, usr=tight_owner.id)
    match8, path8, creds8 = await tight_match(500)
    await finish(path8, creds8, 2)
    short = (await ok(http, "POST", path8 + "/claim", {**creds8[2], "destination": (await outside_invoice(1000, "short"))[0]}))["match"]
    check("a 1000 sat prize from a wallet 7 sats short of the reserve is not sent", short["settlement"]["status"] == "refused" and await balance(tight_wallet) == 1003, f"{short['settlement']['status']}, wallet {await balance(tight_wallet)}")
    await update_wallet_balance(wallet=tight_wallet, amount=50)
    racers = [await outside_invoice(1000, f"racer {n}") for n in range(4)]
    results = await asyncio.gather(*[api(http, "POST", path8 + "/claim", {**creds8[2], "destination": bolt11}) for bolt11, _ in racers])
    summary = [("settling" if r["data"].get("settling") else r["data"]["match"]["settlement"]["status"]) if r.get("ok") else "error: " + r.get("error", "")[:60] for r in results]
    await asyncio.sleep(0.5)
    final = (await ok(http, "POST", path8 + "/claim", {**creds8[2], "destination": racers[0][0]}))["match"]
    winners = [payment_hash for _, payment_hash in racers if payment_hash in funding.paid_invoices]
    check("after a refusal, 4 simultaneous claims to 4 different outside wallets: one is paid", len(winners) == 1 and final["settlement"]["status"] == "paid" and await balance(tight_wallet) == 53, f"{summary}, {len(winners)} paid, wallet {await balance(tight_wallet)}")

    # A match already stuck by the previous version: its lock is used up, the
    # invoice is bound in the match row, the payout was refused for the reserve
    # and no attempt was ever recorded. Written straight into storage, as the
    # previous build left it.
    for wallet in (ana, bo):
        await update_wallet_balance(wallet=wallet, amount=10000)
    match10, path10, creds10 = await tight_match(5000)
    await finish(path10, creds10, 1)
    bound, bound_hash = await outside_invoice(10000, "bound by the previous version")
    async with Database("ext_lnpool").connect() as conn:
        await conn.execute(
            f"UPDATE {_table_ref_for_schema('lnpool', 'lnpool_matches')} SET payout_seat = 1, payout_amount = 10000, payout_bolt11 = :bolt11, payout_hash = :hash, payout_status = 'failed', note = :note WHERE id = :id",  # noqa: S608
            {"bolt11": bound, "hash": bound_hash, "note": "Payout failed: You must reserve at least (100  sat) to cover potential routing fees.", "id": match10},
        )
    elsewhere, elsewhere_hash = await outside_invoice(10000, "somewhere else")
    stuck = (await ok(http, "POST", path10 + "/claim", {**creds10[1], "destination": elsewhere}))["match"]
    check("a match stuck by the previous version stays bound to its invoice: nothing is paid while the wallet is short", stuck["settlement"]["status"] == "failed" and await balance(tight_wallet) == 10053 and not ({bound_hash, elsewhere_hash} & funding.paid_invoices), f"{stuck['settlement']['status']}, wallet {await balance(tight_wallet)}")
    await update_wallet_balance(wallet=tight_wallet, amount=100)
    freed = (await ok(http, "POST", path10 + "/claim", {**creds10[1], "destination": elsewhere}))["match"]
    check("...after a top-up the same claim pays the bound invoice, and only that one", freed["settlement"]["status"] == "paid" and bound_hash in funding.paid_invoices and elsewhere_hash not in funding.paid_invoices and await balance(tight_wallet) == 153, f"{freed['settlement']['status']}, wallet {await balance(tight_wallet)}")

    # A payment the node fails. LNbits keeps a failed payment for that invoice;
    # until it confirms the failure, no other destination is accepted.
    match9, path9, creds9 = await new_match()
    await finish(path9, creds9, 1)
    hall_mid = await balance(hall_wallet)
    unpayable, unpayable_hash = await outside_invoice(2000, "a wallet the node cannot reach")
    funding.payment_secrets.pop(unpayable_hash)  # FakeWallet now fails it, as a node with no route would
    failed = (await ok(http, "POST", path9 + "/claim", {**creds9[1], "destination": unpayable}))["match"]
    check("a payout the node fails is reported as failed, and nothing leaves the wallet", failed["settlement"]["status"] == "failed" and "Payment failed" in failed["settlement"].get("detail", "") and await balance(hall_wallet) == hall_mid, f"{failed['settlement']['status']}: {failed['settlement'].get('detail', '')[:70]}")
    other, other_hash = await outside_invoice(2000, "another wallet")
    held = (await ok(http, "POST", path9 + "/claim", {**creds9[1], "destination": other}))["match"]
    check("...and while LNbits cannot confirm that failure, another destination is not paid", held["settlement"]["status"] in ("unconfirmed", "failed") and other_hash not in funding.paid_invoices and await balance(hall_wallet) == hall_mid, held["settlement"]["status"])

    # --- a slow node, and LNbits' time limit for one call ---------------------
    # LNbits stops an extension call after wasm_runtime_max_execution_ms, host
    # calls included, and does not cancel a payment that is under way. On the
    # first real payout the money arrived and the call was stopped before it
    # could record that.
    delays = {}  # bolt11 -> seconds the node takes to pay it
    node_pay = funding.pay_invoice

    async def slow_pay(bolt11, fee_limit_msat):
        await asyncio.sleep(delays.get(bolt11, 0))
        return await node_pay(bolt11, fee_limit_msat)

    funding.pay_invoice = slow_pay
    default_limit = settings.wasm_runtime_max_execution_ms

    match11, path11, creds11 = await new_match()
    await finish(path11, creds11, 1)
    patient, patient_hash = await outside_invoice(2000, "a node that takes its time")
    delays[patient] = 3.5
    started = time.perf_counter()
    slow_paid = await api(http, "POST", path11 + "/claim", {**creds11[1], "destination": patient})
    took = time.perf_counter() - started
    check("a payment the node takes 3.5 s over is paid and recorded within the default 5 s limit", default_limit == 5000 and slow_paid.get("ok") is True and slow_paid["data"]["match"]["settlement"]["status"] == "paid" and patient_hash in funding.paid_invoices, f"{took:.1f} s" if slow_paid.get("ok") else slow_paid.get("error", "")[:80])

    # The real case: a hall wallet with just enough for a 9 sat prize, and a
    # call that runs out of time while the node is paying. The limit is
    # lowered for this one call so that the test does not have to be slow.
    exact_owner = await create_user_account()
    exact_wallet = await create_wallet(user_id=exact_owner.id, wallet_name="hall with just enough")
    await update_wallet_balance(wallet=exact_wallet, amount=2)
    await http.put("/api/v1/extension/lnpool/enable", params={"usr": exact_owner.id})
    exact = (await ok(http, "PUT", "/hall", {"enabled": True, "walletId": exact_wallet.id, "walletName": "exact", "minStake": 5, "maxStake": 5000, "feePercent": 10}, usr=exact_owner.id))["hall"]
    await http.post("/api/v1/extension/lnpool/permissions/background-payment", params={"usr": exact_owner.id}, json={"wallet_id": exact_wallet.id, "max_amount": 10000, "destination_policy": "external_allowed"})
    created = await ok(http, "POST", f"/halls/{exact['id']}/matches", {"name": "Ana", "stake": 5})
    match12 = created["match"]["id"]
    path12 = f"/matches/{match12}"
    await pay_invoice(wallet_id=ana.id, payment_request=created["paymentRequest"])
    await wait_for(lambda: seat_paid(http, path12, 0), "seat 1 to be paid")
    joined = await ok(http, "POST", path12 + "/join", {"name": "Bo"})
    await pay_invoice(wallet_id=bo.id, payment_request=joined["paymentRequest"])
    await wait_for(lambda: status_is(http, path12, "active"), "match to start")
    creds12 = {1: {"playerId": created["playerId"], "token": created["token"]}, 2: {"playerId": joined["playerId"], "token": joined["token"]}}
    await finish(path12, creds12, 1)

    arrived, arrived_hash = await outside_invoice(9, "arrives while the call is stopped")
    delays[arrived] = 2.5
    print("  (LNbits logs a traceback for the next call: it is the one stopped on purpose)")
    settings.wasm_runtime_max_execution_ms = 1500
    stopped = await api(http, "POST", path12 + "/claim", {**creds12[1], "destination": arrived})
    settings.wasm_runtime_max_execution_ms = default_limit
    stopped_call = fuelprobe.last("claim-lnpool-payout")
    check("LNbits stops the paying call (time, not fuel) and the payment arrives all the same", stopped.get("ok") is False and "500" in stopped.get("error", "") and arrived_hash in funding.paid_invoices and await balance(exact_wallet) == 3, f"{stopped.get('error', '')[:40]}, {stopped_call['total'] / 1e6:.1f}M fuel used, wallet {await balance(exact_wallet)}")
    detail = await ok(http, "GET", f"/matches/{match12}/admin", usr=exact_owner.id)
    check("...what is left behind: the invoice recorded, a payment started, no result", [p["status"] for p in detail["payouts"]] == ["bound", "started"] and detail["match"]["payoutStatus"] == "paying", str([p["status"] for p in detail["payouts"]]))

    elsewhere, elsewhere_hash = await outside_invoice(9, "another wallet")
    soon = await api(http, "POST", path12 + "/claim", {**creds12[1], "destination": elsewhere})
    check("a claim straight afterwards does nothing, whatever wallet it names", soon.get("ok") is True and soon["data"].get("settling") is True and elsewhere_hash not in funding.paid_invoices)
    async with Database("ext_lnpool").connect() as conn:  # half a minute later
        await conn.execute(f"UPDATE {_table_ref_for_schema('lnpool', 'lnpool_payouts')} SET updated_at = updated_at - 60 WHERE match_id = :id", {"id": match12})  # noqa: S608
    unknown = (await ok(http, "POST", path12 + "/claim", {**creds12[1], "destination": elsewhere}))["match"]
    check("the follow-up cannot confirm it from a wallet the payout emptied: unconfirmed, and no other wallet is paid", unknown["settlement"]["status"] == "unconfirmed" and elsewhere_hash not in funding.paid_invoices and await balance(exact_wallet) == 3, f"{unknown['settlement']['status']}: {unknown['settlement'].get('detail', '')[-60:]}")
    await update_wallet_balance(wallet=exact_wallet, amount=8)  # the prize and the reserve are in the wallet again
    async with Database("ext_lnpool").connect() as conn:
        await conn.execute(f"UPDATE {_table_ref_for_schema('lnpool', 'lnpool_payouts')} SET updated_at = updated_at - 60 WHERE match_id = :id", {"id": match12})  # noqa: S608
    found = (await ok(http, "POST", path12 + "/claim", {**creds12[1], "destination": elsewhere}))["match"]
    check("once the wallet could pay it again, LNbits answers from its record: paid, and nothing is sent", found["settlement"]["status"] == "paid" and await balance(exact_wallet) == 11 and elsewhere_hash not in funding.paid_invoices, f"{found['settlement']['status']}, wallet {await balance(exact_wallet)}")
    funding.pay_invoice = node_pay

    check("fuel was measured for every call", FUEL_MEASURED and len(fuelprobe.calls) > 0, f"{len(fuelprobe.calls)} invocations")
    cut_off = [call for call in fuelprobe.calls if not call["ok"]]
    check("no call was cut off by the runtime, except the one stopped on purpose above", cut_off == [stopped_call], ", ".join(call["export"] for call in cut_off))
    worst = fuelprobe.worst()
    check(f"no call used more than half of the default fuel limit ({FUEL_BUDGET // 1_000_000}M)", bool(worst) and worst[0]["total"] <= FUEL_BUDGET, f"dearest: {worst[0]['export']} {worst[0]['total'] / 1e6:.1f}M" if worst else "")
    print("\n  fuel  most expensive invocation of each export, in millions (limit 100):")
    for call in worst:
        print(f"  fuel    {call['export']:26s} {call['total'] / 1e6:6.1f}")
    if claim_call:
        print("  fuel  the full-size claim, step by step (fuel the guest used before each host call):")
        for line in fuelprobe.timeline(claim_call):
            print("  fuel    " + line)

    ordered = sorted(timings)
    print(f"\n{len(timings)} API calls through WASM: median {ordered[len(ordered) // 2]:.0f} ms, p90 {ordered[int(len(ordered) * 0.9)]:.0f} ms, max {ordered[-1]:.0f} ms")


async def seat_paid(http, path, index):
    view = (await ok(http, "GET", path))["match"]
    return view["seats"][index]["paid"]


async def status_is(http, path, status):
    return (await ok(http, "GET", path))["match"]["status"] == status


asyncio.run(main())
failed = [name for name, passed in checks if not passed]
print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
sys.exit(1 if failed else 0)
