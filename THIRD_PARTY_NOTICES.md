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

## LNbits and LNQ1

The extension layout, the `config.json` shape, the WIT `host` interface, the
jco build command and the iframe bridge message protocol follow LNbits core
(MIT) and the LNQ1 extension. No LNQ1 source file is copied: LNQ1 has no
licence file, so `dev/src/lnbits-sdk.js` and `static/lnbits-extension-sdk.js`
were written for this project against the protocol LNbits core defines.

## Rules

The 8-ball rule set follows the rule list of the pool game in the author's
own blobbi-island project. It was reimplemented here; no code was copied.
