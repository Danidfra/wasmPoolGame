#!/bin/sh
# Runs the end-to-end check against an LNbits checkout.
#
#   LNBITS_DIR=/path/to/lnbits ./run.sh
#
# LNBITS_DIR is an LNbits source checkout with its virtualenv in .venv.
#
# Uses a fresh throwaway data folder every time. Build wasm/module.wasm first.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
EXT=$(cd "$HERE/../.." && pwd)
if [ -z "$LNBITS_DIR" ] || [ ! -x "$LNBITS_DIR/.venv/bin/python" ]; then
  echo "Set LNBITS_DIR to an LNbits checkout that has a .venv (see the top of this file)." >&2
  exit 2
fi
LNPOOL_E2E_WORK=$(mktemp -d)
export LNPOOL_E2E_WORK
trap 'rm -rf "$LNPOOL_E2E_WORK"' EXIT
mkdir -p "$LNPOOL_E2E_WORK/data/wasm_extensions" "$LNPOOL_E2E_WORK/extroot/extensions"
ln -s "$EXT" "$LNPOOL_E2E_WORK/data/wasm_extensions/lnpool"
# LNbits resolves its static files relative to the checkout.
cd "$LNBITS_DIR"
.venv/bin/python "$HERE/run_e2e.py" 2>&1 | grep -E "^  (ok|FAIL|fuel|\()|checks passed|API calls|Loaded WASM|Traceback|Error"
