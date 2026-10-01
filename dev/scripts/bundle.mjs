// Concatenates src/lnbits-sdk.js and src/index.js into the single ES module
// jco componentizes. Same approach as LNQ1: the SDK's `export const` become
// plain `const`, and index.js loses its one local import.
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const devDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = await readFile(resolve(devDir, 'src/lnbits-sdk.js'), 'utf8')
const entry = await readFile(resolve(devDir, 'src/index.js'), 'utf8')

const localImport = /^import \{[^}]+\} from '\.\/lnbits-sdk\.js'\n\n/
if (!localImport.test(entry)) throw new Error('src/index.js must start with its lnbits-sdk.js import.')

const outPath = resolve(devDir, 'dist/index.bundle.js')
await mkdir(dirname(outPath), {recursive: true})
await writeFile(outPath, `${sdk.replace(/^export const /gm, 'const ')}\n\n${entry.replace(localImport, '')}`, 'utf8')
