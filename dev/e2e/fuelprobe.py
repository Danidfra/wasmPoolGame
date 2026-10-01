"""Measures the WASM fuel each lnpool call burns, from inside the test harness.

Nothing in LNbits is edited and the fuel limit is left alone: this wraps three
internal functions in this process only, and records for every invocation how
much fuel the guest used before each host call and after the last one. If a
future LNbits renames those functions, `install()` returns False and the
harness says so instead of guessing.
"""
import threading

calls = []  # {"export", "total", "steps": [(host function, fuel since the previous point)], "ok"}
_state = {}


def install():
    try:
        import lnbits.core.wasm_ext.wasm.host as host
        import lnbits.core.wasm_ext.wasm.invoke as invoke

        set_fuel = invoke._set_store_fuel
        run_export = invoke._invoke_wasm_extension_export_sync
        make_import = host._make_host_import
    except (ImportError, AttributeError):
        return False

    def used(state):
        return state["limit"] - state["store"].get_fuel()

    def set_fuel_and_remember(store, limits):
        set_fuel(store, limits)
        _state[threading.get_ident()] = {"store": store, "limit": limits["wasm_runtime_max_fuel"], "last": 0, "steps": []}

    def make_measured_import(api_host, host_name, empty_request, event_loop):
        inner = make_import(api_host, host_name, empty_request, event_loop)

        def measured(store, *args):
            state = _state.get(threading.get_ident())
            if state:
                state["steps"].append((host_name, used(state) - state["last"]))
            result = inner(store, *args)
            if state:
                state["last"] = used(state)
            return result

        return measured

    def run_measured_export(extension, export_name, *args, **kwargs):
        ok = True
        try:
            return run_export(extension, export_name, *args, **kwargs)
        except BaseException:
            ok = False
            raise
        finally:
            state = _state.pop(threading.get_ident(), None)
            if state:
                try:
                    total = used(state)
                except Exception:
                    total = state["limit"]
                state["steps"].append(("(return)", total - state["last"]))
                calls.append({"export": export_name, "total": total, "steps": state["steps"], "ok": ok})

    invoke._set_store_fuel = set_fuel_and_remember
    invoke._invoke_wasm_extension_export_sync = run_measured_export
    host._make_host_import = make_measured_import
    return True


def last(export_name):
    for call in reversed(calls):
        if call["export"] == export_name:
            return call
    return None


def worst():
    """The most expensive invocation of each export, dearest first."""
    top = {}
    for call in calls:
        if call["export"] not in top or call["total"] > top[call["export"]]["total"]:
            top[call["export"]] = call
    return sorted(top.values(), key=lambda call: -call["total"])


def timeline(call):
    return [f"{fuel / 1e6:7.2f}M  then -> {name}" for name, fuel in call["steps"]]
