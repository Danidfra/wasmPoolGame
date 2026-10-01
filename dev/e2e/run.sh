#!/bin/sh
# Runs the end-to-end check against an LNbits checkout.
#
#   LNBITS_DIR=~/Developer/lnbits-work/lnbits ./run.sh
#
# Uses a fresh throwaway data folder every time. Build wasm/module.wasm first.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
EXT=$(cd "$HERE/../.." && pwd)
LNBITS_DIR=${LNBITS_DIR:-$HOME/Developer/lnbits-work/lnbits}
LNPOOL_E2E_WORK=$(mktemp -d)
export LNPOOL_E2E_WORK
trap 'rm -rf "$LNPOOL_E2E_WORK"' EXIT
mkdir -p "$LNPOOL_E2E_WORK/data/wasm_extensions" "$LNPOOL_E2E_WORK/extroot/extensions"
ln -s "$EXT" "$LNPOOL_E2E_WORK/data/wasm_extensions/lnpool"
# LNbits resolves its static files relative to the checkout.
cd "$LNBITS_DIR"
.venv/bin/python "$HERE/run_e2e.py" 2>&1 | grep -E "^  (ok|FAIL|fuel)|checks passed|API calls|Loaded WASM|Traceback|Error"
