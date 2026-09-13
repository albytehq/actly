/**
 * actly build pipeline.
 *
 * 1. tsc emits declarations only (per-module d.ts under dist) — types stay
 *    tsc-exact.
 * 2. esbuild bundles each entry into ONE minified ESM file and ONE
 *    standalone CJS file. The CJS bundle requires no require(esm) support,
 *    so the package works on every Node >= 20 (v1.3 shipped a CJS entry
 *    that required ESM files and only worked on Node 22.12+/20.19+).
 *
 * No source maps are published; the dist layout is:
 *   dist/index.js, dist/index.cjs, dist/index.d.ts (+ per-module d.ts)
 *   dist/testing/index.js, dist/testing/index.cjs (+ d.ts)
 */
import { rmSync, mkdirSync } from 'fs'
import { build } from 'esbuild'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { relative, dirname, join } from 'path'

const root = fileURLToPath(new URL('..', import.meta.url))

// Wipe dist entirely: tsc overwrites d.ts files but never deletes the ones
// whose source disappeared — a renamed module would ship stale declarations
// (exactly how a leftover stores/base.d.ts once slipped into a release audit).
rmSync(join(root, 'dist'), { recursive: true, force: true })
mkdirSync(join(root, 'dist'), { recursive: true })

// 1. Declarations
execFileSync('npx', ['tsc', '--project', 'tsconfig.build.json'], {
  cwd: root, stdio: 'inherit',
})

// 2. Bundles
for (const f of ['dist/index.js', 'dist/index.cjs', 'dist/testing/index.js', 'dist/testing/index.cjs']) {
  rmSync(join(root, f), { force: true })
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'info',
  sourcemap: false,
  sourcesContent: false,
}

await build({
  ...shared,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/index.js'),
  format: 'esm',
})

await build({
  ...shared,
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(root, 'dist/index.cjs'),
  format: 'cjs',
})

await build({
  ...shared,
  entryPoints: [join(root, 'src/testing/index.ts')],
  outfile: join(root, 'dist/testing/index.js'),
  format: 'esm',
})

await build({
  ...shared,
  entryPoints: [join(root, 'src/testing/index.ts')],
  outfile: join(root, 'dist/testing/index.cjs'),
  format: 'cjs',
})

// 3. Report the artifacts that will ship
import { readdirSync, statSync } from 'fs'
function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else acc.push(p)
  }
  return acc
}
const files = walk(join(root, 'dist'))
let total = 0
for (const f of files) total += statSync(f).size
console.log(`\ndist: ${files.length} files, ${(total / 1024).toFixed(1)} KB`)
for (const f of files.sort()) {
  const rel = relative(root, f)
  if (rel.endsWith('.js') || rel.endsWith('.cjs')) {
    console.log(`  ${rel.padEnd(34)} ${(statSync(f).size / 1024).toFixed(1)} KB`)
  }
}
