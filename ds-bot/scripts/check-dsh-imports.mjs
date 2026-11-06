// C0.1: the host code and the tests must load without DeepSeek Harness. Only the module
// that registers the LLM adapter may import a DSH package, and the two client files that
// the bundle compiles its DSH primitives into are out of this check's scope.
// Usage: node scripts/check-dsh-imports.mjs
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ALLOWED = new Set([
  'src/host/llm-dsh.js', // the LlmAdapter base the harness registry requires
  'src/client/dsh-primitives.js', // compiled into client.js against the DSH client bundle
  'src/client/user-message.js',
])
// Tests may reach a DSH package only when they are about the harness entry itself. Everything
// else runs on src/host/runtime.js, which takes the adapter base as a dependency.
const TEST_CLOSURE_ALLOWED = new Set([
  'test/constants.test.js', // asserts what index.js hands the harness: name, inject, COLORS
])

const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name)
  if (entry.isDirectory()) return files(path)
  return entry.name.endsWith('.js') || entry.name.endsWith('.mjs') ? [path] : []
})

// Static imports only: a dynamic import of a DSH package runs when its code path needs it.
const dshImports = file => {
  const text = readFileSync(file, 'utf8')
  const specs = []
  for (const match of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) specs.push(match[1])
  for (const match of text.matchAll(/\bimport\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) specs.push(match[1])
  return specs
}

const offenders = [...files(join(root, 'src')), ...files(join(root, 'test'))]
  .filter(file => !ALLOWED.has(relative(root, file).replaceAll('\\', '/')))
  .map(file => ({ file: relative(root, file).replaceAll('\\', '/'), specs: dshImports(file) }))
  .filter(entry => entry.specs.length > 0)

if (offenders.length > 0) {
  for (const entry of offenders) console.error(`check-dsh-imports: ${entry.file} imports ${entry.specs.join(', ')}`)
  console.error('check-dsh-imports: move the need behind src/host/vendor/, or add the file to ALLOWED with a reason')
  process.exit(1)
}

// A file's own imports are only half of it: what it loads loads what it imports. The tests
// run on src/host/runtime.js so that none of them pulls a harness package in at import time,
// which is what lets them go on running after phase C takes DSH out of the install.
const resolveRelative = (spec, from) => {
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/** The DSH packages a file reaches through its static imports, however deep. */
const closureSpecs = (entry) => {
  const seen = new Set()
  const specs = new Set()
  const pending = [resolve(entry)]
  while (pending.length > 0) {
    const file = pending.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const spec of dshImports(file)) specs.add(spec)
    for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const next = resolveRelative(match[1], file)
      if (next !== undefined && !seen.has(next)) pending.push(next)
    }
  }
  return [...specs]
}

const checked = [
  ...readdirSync(join(root, 'test')).filter(name => name.endsWith('.test.js')).map(name => relative(root, join(root, 'test', name)).replaceAll('\\', '/')),
  'src/host/runtime.js',
].filter(path => !TEST_CLOSURE_ALLOWED.has(path))
const reachers = checked.map(path => ({ path, specs: closureSpecs(join(root, path)) })).filter(entry => entry.specs.length > 0)

if (reachers.length > 0) {
  for (const entry of reachers) console.error(`check-dsh-imports: ${entry.path} loads ${entry.specs.join(', ')} at import time`)
  console.error('check-dsh-imports: run it on src/host/runtime.js (the adapter base comes in as a dependency), or add the file to TEST_CLOSURE_ALLOWED with a reason')
  process.exit(1)
}
console.log('check-dsh-imports: no DSH import outside the allowed files')
console.log(`check-dsh-imports: no DSH package in the import closure of ${String(checked.length)} checked files`)
