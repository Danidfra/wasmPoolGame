// Checks that the archive GitHub would build for a commit can be installed by
// LNbits and accepted by the WASM extension catalog. The rules are the ones in
// lnbits/core/models/extensions.py (validate_archive) and in
// update_version.py of lnbits/lnbits-extensions-wasm.
//
//   node scripts/check-release.mjs [commit]      (default: HEAD)
import {execFileSync} from 'node:child_process'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const commit = process.argv[2] || 'HEAD'
const git = (...args) => execFileSync('git', args, {cwd: root, maxBuffer: 64 * 1024 * 1024})
const problems = []
const check = (ok, message) => {
  if (!ok) problems.push(message)
}

// Exactly what `git archive` (and so GitHub's tag archive) would contain.
const tar = git('archive', '--format=tar', commit)
const files = execFileSync('tar', ['-tf', '-'], {input: tar, maxBuffer: 64 * 1024 * 1024})
  .toString()
  .split('\n')
  .filter(path => path && !path.endsWith('/'))

const forbidden = ['.py', '.pyc', '.pyo', '.pyd', '.so', '.dll', '.dylib', '.exe']
for (const path of files) {
  const name = path.split('/').pop().toLowerCase()
  check(!forbidden.some(suffix => name.endsWith(suffix)), 'native or Python file in the archive: ' + path)
  check(!path.toLowerCase().split('/').includes('__pycache__'), 'Python cache in the archive: ' + path)
  check(name !== 'config.json' || path === 'config.json', 'a second config.json in the archive: ' + path)
}
const links = git('ls-tree', '-r', commit).toString().split('\n').filter(line => line.startsWith('120000'))
check(!links.length, 'symlinks in the repository: ' + links.map(line => line.split('\t')[1]).join(', '))

check(files.includes('config.json'), 'no config.json at the top level')
const config = JSON.parse(git('show', commit + ':config.json').toString())
const pkg = JSON.parse(git('show', commit + ':dev/package.json').toString())
check(config.id === 'lnpool', 'config.json id is ' + config.id + '; the repository has to be named after it')
check(config.extension_type === 'wasm', 'config.json extension_type is not "wasm"')
check(/^\d+\.\d+\.\d+$/.test(config.version || ''), 'config.json version is not X.Y.Z: ' + config.version)
check(config.version === pkg.version, 'config.json says ' + config.version + ', dev/package.json says ' + pkg.version)
check(!!config.min_lnbits_version, 'config.json has no min_lnbits_version')
check(!!config.name && !!config.short_description, 'config.json needs a name and a short_description')

const modulePath = config.wasm && config.wasm.module
check(typeof modulePath === 'string' && files.includes(modulePath), 'wasm.module is missing from the archive: ' + modulePath)
if (files.includes(modulePath)) {
  const magic = git('show', commit + ':' + modulePath).subarray(0, 4)
  check(magic.equals(Buffer.from([0, 0x61, 0x73, 0x6d])), modulePath + ' is not a WebAssembly file')
}
const tile = String(config.tile || '').replace('/ext-assets/' + config.id + '/', 'static/')
check(files.includes('static/assets/icon.png'), 'static/assets/icon.png is missing (LNbits shows it for every WASM extension)')
check(!config.tile || files.includes(tile), 'the tile in config.json is missing from the archive: ' + tile)
for (const route of config.ui_routes || []) check(files.includes(route.entrypoint), 'ui route entrypoint is missing: ' + route.entrypoint)
const exported = new Set(((config.wasm && config.wasm.exports) || []).map(item => item.name))
for (const route of config.api_routes || []) check(exported.has(route.export), 'api route uses an export that is not declared: ' + route.export)

if (problems.length) {
  console.error('Not releasable (' + commit + '):\n  ' + problems.join('\n  '))
  process.exit(1)
}
console.log('Release archive for ' + commit + ' is fine: ' + files.length + ' files, version ' + config.version + ', tag it v' + config.version + '.')
