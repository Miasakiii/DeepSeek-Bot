// C0.1: the host code and the tests must load without DeepSeek Harness. Only the module
// that registers the LLM adapter may import a DSH package, and the two client files that
// the bundle compiles its DSH primitives into are out of this check's scope.
// Usage: node scripts/check-dsh-imports.mjs
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const ALLOWED = new Set([
  'src/host/llm-dsh.js', // the LlmAdapter base the harness registry requires
  'src/client/dsh-primitives.js', // compiled into client.js against the DSH client bundle
  'src/client/user-message.js',
  'test/browser-plugin-output.test.js', // boots the DSH tool runtime; C0.3 moves it to the fake host
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
console.log('check-dsh-imports: no DSH import outside the allowed files')
