# Third-party notices

## billiard-clash

`static/pool-engine.js` (table proportions, physics constants, the simulation
step, collision response, cue-ball placement, rack geometry) and
`static/pool-table.js` (the canvas renderer) are adapted from
[billiard-clash](https://github.com/Lujain-ALghamdi/billiard-clash), commit
`858d611`, files `shared/src/{constants,vector2}.ts`,
`shared/src/physics/{engine,shot,placement,rack}.ts` and
`client/src/game/TableRenderer.ts`.

What was changed: ported from TypeScript to plain JavaScript; the simulation
only ever advances in whole fixed steps; the rack is shuffled from a seed
instead of `Math.random`; the triangle uses `sqrt(3)/2` instead of `sin(60°)`;
a contact is recorded only on a real impact; the top shot speed is higher; the
8-ball rules were replaced (see the rule list in `pool-engine.js`). Nothing
from billiard-clash's server, networking, AI, UI screens or styles is used.

```
MIT License

Copyright (c) 2026 Lujain-ALghamdi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## qrcode-generator

`static/vendor/qrcode.js` is `dist/qrcode.js` from the npm package
[qrcode-generator](https://www.npmjs.com/package/qrcode-generator) 2.0.4,
unmodified. Copyright (c) 2009 Kazuhiko Arase, MIT License (the notice is at
the top of the file). The word "QR Code" is a registered trademark of DENSO
WAVE INCORPORATED.

## The JavaScript runtime inside `wasm/module.wasm`

`wasm/module.wasm` is built from `dev/src/` by `npm run build:wasm`, that is
by [jco](https://github.com/bytecodealliance/jco) 1.19.0 and
[ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS) 0.20.0
(Bytecode Alliance; Apache License 2.0 with LLVM exceptions). A JavaScript
component has to carry its own engine, so the module contains, unmodified and
as that toolchain emits it, the
[StarlingMonkey](https://github.com/bytecodealliance/StarlingMonkey) runtime
(Apache License 2.0 with LLVM exceptions), which embeds Mozilla's SpiderMonkey
JavaScript engine (Mozilla Public License 2.0) and OpenSSL (under OpenSSL's
own licence). Their source is available from those projects; nothing in them
was changed for LN Pool. Only `dev/src/` is LN Pool's own code in that file.

## LNbits

The extension layout, the `config.json` shape, the jco build command and the
iframe bridge message protocol follow LNbits core (MIT) and the WASM
extensions the LNbits project publishes. `wasm/lnbits-extension.wit` declares
the host functions LN Pool imports; its record and function names are the
ones LNbits core defines (`lnbits/core/wasm_ext/api/models.py`), so they read
the same as in any other extension written for that host. No source file of
another extension is copied: those repositories carry no licence file, so
`dev/src/lnbits-sdk.js` and `static/lnbits-extension-sdk.js` were written for
this project against the protocol LNbits core defines.

## Rules

The 8-ball rule set follows a rule list the author wrote for an earlier pool
game of their own. It was reimplemented here; no code was copied.
