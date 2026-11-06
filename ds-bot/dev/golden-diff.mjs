// The double-run check phase C is gated on (decouple plan §C0.4): run the same scenario on
// two runtimes, write each transcript with `node dev/smoke.mjs … --out <file>`, then compare
// them here. A difference is a phase-C bug until it is explained, so an explaining rule is
// written down instead of a difference being ignored.
//
//   node dev/golden-diff.mjs <baseline.json> <candidate.json> [--mask <rules.json>] [--out <report.md>]
//
// A mask rule is { path, keep? }: `path` is a dotted path where `*` matches one segment and
// `**` matches any number of segments; a value at a matching path is replaced with `<masked>`
// before comparing, or kept when `keep` is a regular expression source it must still match.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const usage = 'usage: node dev/golden-diff.mjs <baseline.json> <candidate.json> [--mask <rules.json>] [--out <report.md>]'

/** Every leaf of a transcript step, as a dotted path. */
export function flatten(value, prefix = '') {
  if (value === null || typeof value !== 'object') return { [prefix || '(root)']: value }
  if (Array.isArray(value)) {
    return value.reduce((out, item, index) => Object.assign(out, flatten(item, `${prefix}.${index}`)), {})
  }
  return Object.keys(value).reduce((out, key) => Object.assign(out, flatten(value[key], prefix === '' ? key : `${prefix}.${key}`)), {})
}

/** Whether a rule path covers a leaf path: `*` is one segment, `**` is any number. */
const covers = (pattern, path) => {
  if (pattern.length === 0) return path.length === 0
  const [head, ...rest] = pattern
  if (head === '**') return covers(rest, path) || (path.length > 0 && covers(pattern, path.slice(1)))
  if (path.length === 0) return false
  return (head === '*' || head === path[0]) && covers(rest, path.slice(1))
}

/** Replace the values the rules explain away, and reject a value that no longer fits them. */
export function applyMasks(leaves, rules) {
  const compiled = rules.map(rule => ({ ...rule, pattern: rule.path.split('.') }))
  const broken = []
  const masked = {}
  for (const [path, value] of Object.entries(leaves)) {
    const rule = compiled.find(candidate => covers(candidate.pattern, path.split('.')))
    if (rule === undefined) {
      masked[path] = value
      continue
    }
    if (rule.keep !== undefined && !new RegExp(rule.keep, 'u').test(String(value ?? ''))) {
      broken.push(`${path}: ${JSON.stringify(value)} does not match the rule for ${rule.path}`)
    }
    masked[path] = '<masked>'
  }
  return { masked, broken }
}

const stepsOf = transcript => transcript.map((step, index) => ({ ...step, index }))

/** Compare two transcripts: step sets first, then the leaves of the steps they share. */
export function diffTranscripts(baseline, candidate, rules = []) {
  const report = { missing: [], added: [], moved: [], steps: [], ruleViolations: [] }
  const wanted = stepsOf(baseline)
  const got = stepsOf(candidate)
  const byTitle = new Map(got.map(step => [step.step, step]))
  const seen = new Set()
  for (const step of wanted) {
    const other = byTitle.get(step.step)
    if (other === undefined) {
      report.missing.push(step.step)
      continue
    }
    seen.add(step.step)
    if (other.index !== step.index) report.moved.push(`${step.step}: step ${String(step.index + 1)} became ${String(other.index + 1)}`)
    const left = applyMasks(flatten({ said: step.said ?? [], state: step.state ?? {} }), rules)
    const right = applyMasks(flatten({ said: other.said ?? [], state: other.state ?? {} }), rules)
    report.ruleViolations.push(...left.broken.map(line => `${step.step} (baseline) ${line}`), ...right.broken.map(line => `${step.step} (candidate) ${line}`))
    const differences = []
    for (const path of new Set([...Object.keys(left.masked), ...Object.keys(right.masked)])) {
      const before = left.masked[path]
      const after = right.masked[path]
      if (before === undefined) differences.push(`+ ${path}: ${JSON.stringify(after)}`)
      else if (after === undefined) differences.push(`- ${path}: ${JSON.stringify(before)}`)
      else if (JSON.stringify(before) !== JSON.stringify(after)) differences.push(`~ ${path}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    }
    if (differences.length > 0) report.steps.push({ step: step.step, differences })
  }
  report.added = got.filter(step => !seen.has(step.step)).map(step => step.step)
  report.clean = report.missing.length + report.added.length + report.moved.length + report.steps.length + report.ruleViolations.length === 0
  return report
}

export function formatReport(report, names) {
  const lines = [`Golden diff: ${names.baseline} → ${names.candidate}`, '']
  if (report.clean) return `${lines.join('\n')}difference: 0\n`
  if (report.missing.length > 0) lines.push(`Steps the candidate does not reach (${String(report.missing.length)}):`, ...report.missing.map(title => `  - ${title}`), '')
  if (report.added.length > 0) lines.push(`Steps only the candidate reaches (${String(report.added.length)}):`, ...report.added.map(title => `  + ${title}`), '')
  if (report.moved.length > 0) lines.push(`Steps out of order (${String(report.moved.length)}):`, ...report.moved.map(line => `  ! ${line}`), '')
  if (report.ruleViolations.length > 0) lines.push(`Values a mask rule no longer explains (${String(report.ruleViolations.length)}):`, ...report.ruleViolations.map(line => `  ? ${line}`), '')
  if (report.steps.length > 0) {
    lines.push(`Steps that differ (${String(report.steps.length)}):`, '')
    for (const step of report.steps) lines.push(`  ${step.step}`, ...step.differences.map(line => `    ${line}`), '')
  }
  lines.push(`difference: ${String(report.steps.reduce((total, step) => total + step.differences.length, 0) + report.missing.length + report.added.length + report.moved.length + report.ruleViolations.length)}`)
  return lines.join('\n')
}

const readJson = path => JSON.parse(readFileSync(resolve(path), 'utf8'))

/** Compare the two files named on the command line; the return is the exit code CI reads. */
export function run(argv) {
  const flag = name => {
    const at = argv.indexOf(name)
    return at === -1 ? undefined : argv[at + 1]
  }
  const [baselinePath, candidatePath] = argv
  if (argv.length < 2 || baselinePath.startsWith('-')) {
    console.error(usage)
    return 2
  }
  const maskPath = flag('--mask')
  const reportPath = flag('--out')
  const rules = maskPath === undefined ? [] : readJson(maskPath)
  const report = diffTranscripts(readJson(baselinePath), readJson(candidatePath), rules)
  const text = formatReport(report, { baseline: baselinePath, candidate: candidatePath })
  if (reportPath !== undefined) writeFileSync(resolve(reportPath), text)
  console.log(text)
  return report.clean ? 0 : 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2))
}
