/**
 * Post-build: flatten the CommonJS output (dist/cjs/**.js) into dist/**.cjs
 * so the package.json `exports` map ("require": "./dist/index.cjs") resolves.
 *
 * tsc emits `.js` extensions under NodeNext mode for both ESM and CJS passes.
 * Node's CJS resolver needs `.cjs` to disambiguate from the ESM `.js` files
 * when "type": "module" is set in package.json. We rename here rather than
 * fight the emitter.
 *
 * Idempotent: safe to run multiple times. The CJS directory is removed at the
 * end so subsequent builds start from a clean slate.
 */
import { readdirSync, renameSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'

const root    = fileURLToPath(new URL('..', import.meta.url))
const cjsDir  = join(root, 'dist', 'cjs')
const distDir = join(root, 'dist')

if (!existsSync(cjsDir)) {
  console.log('postbuild: no CJS output to flatten, skipping')
  process.exit(0)
}

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.js')) {
      const rel    = relative(cjsDir, full)                       // e.g. core/act.js
      const target = join(distDir, rel.replace(/\.js$/, '.cjs'))  // dist/core/act.cjs
      mkdirSync(dirname(target), { recursive: true })
      renameSync(full, target)
    }
  }
}

walk(cjsDir)
rmSync(cjsDir, { recursive: true, force: true })
console.log('postbuild: CJS files flattened into dist/')
