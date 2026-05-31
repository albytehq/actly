/**
 * Flattens dist/cjs/ into dist/ as .cjs files so the package.json
 * exports map ("require": "./dist/index.cjs") resolves correctly.
 *
 * tsc can't emit .cjs extensions natively (NodeNext mode emits .js),
 * so we do a second CommonJS pass then rename here.
 */
import { readdirSync, renameSync, mkdirSync, rmSync } from 'fs'
import { join, relative, dirname } from 'path'
import { fileURLToPath } from 'url'

const root    = fileURLToPath(new URL('..', import.meta.url))
const cjsDir  = join(root, 'dist', 'cjs')
const distDir = join(root, 'dist')

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
    } else if (entry.name.endsWith('.js')) {
      const rel    = relative(cjsDir, full)                      // e.g. core/act.js
      const target = join(distDir, rel.replace(/\.js$/, '.cjs')) // dist/core/act.cjs
      mkdirSync(dirname(target), { recursive: true })
      renameSync(full, target)
    }
  }
}

walk(cjsDir)
rmSync(cjsDir, { recursive: true, force: true })
console.log('postbuild: CJS files flattened into dist/')
