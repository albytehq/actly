// Prints the shipping size of the package: tarball, unpacked, and per-file
// breakdown of dist. Run via `npm run size`. Keep README size claims
// pointing at this script instead of hardcoding numbers that go stale.
import { execFileSync } from 'child_process'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

const root = fileURLToPath(new URL('..', import.meta.url))

const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
})
const info = JSON.parse(out)[0]
console.log(`tarball:   ${(info.size / 1024).toFixed(1)} KB`)
console.log(`unpacked:  ${(info.unpackedSize / 1024).toFixed(1)} KB`)
console.log(`files:     ${info.files.length}`)

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}

const distFiles = walk(join(root, 'dist'))
let distTotal = 0
const byExt = new Map()
for (const f of distFiles) {
  const s = statSync(f).size
  distTotal += s
  const ext = f.endsWith('.d.ts') ? '.d.ts' : f.endsWith('.js') ? '.js' : f.endsWith('.cjs') ? '.cjs' : 'other'
  byExt.set(ext, (byExt.get(ext) ?? 0) + s)
}
console.log(`dist:      ${distFiles.length} files, ${(distTotal / 1024).toFixed(1)} KB`)
for (const [ext, size] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${ext.padEnd(8)} ${(size / 1024).toFixed(1)} KB`)
}
