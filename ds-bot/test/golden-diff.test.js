import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { applyMasks, diffTranscripts, flatten, formatReport } from '../dev/golden-diff.mjs'

const step = (title, state = {}, said = []) => ({ step: title, said, state })

test('the same transcript on both sides is a clean difference', () => {
  const one = [step('chief greets', { bots: [{ name: 'Chief' }] }, ['tool spawn_bot {}'])]
  const report = diffTranscripts(one, structuredClone(one))
  assert.equal(report.clean, true)
  assert.match(formatReport(report, { baseline: 'a', candidate: 'b' }), /difference: 0/)
})

test('a leaf that changed is named with both values', () => {
  const report = diffTranscripts(
    [step('a', { bots: [{ name: 'Chief', main: true }] })],
    [step('a', { bots: [{ name: 'Chief', main: false }] })],
  )
  assert.equal(report.clean, false)
  assert.deepEqual(report.steps[0].differences, ['~ state.bots.0.main: true → false'])
})

test('a path a rule covers stops being a difference', () => {
  const rules = [{ path: 'state.bots.*.sessionId' }, { path: 'said.**.time' }]
  const report = diffTranscripts(
    [step('a', { bots: [{ sessionId: 'session-1' }] }, ['x'])],
    [step('a', { bots: [{ sessionId: 'session-9' }] }, ['x'])],
    rules,
  )
  assert.equal(report.clean, true, JSON.stringify(report))
})

test('a value that no longer fits the rule it is excused by is reported', () => {
  const rules = [{ path: 'state.bots.*.sessionId', keep: '^session-\\d+$' }]
  const { broken } = applyMasks(flatten({ state: { bots: [{ sessionId: 'ws://127.0.0.1:9' }] } }), rules)
  assert.match(broken[0], /does not match the rule/)
  const report = diffTranscripts(
    [step('a', { bots: [{ sessionId: 'session-1' }] })],
    [step('a', { bots: [{ sessionId: 'https://elsewhere' }] })],
    rules,
  )
  assert.equal(report.ruleViolations.length, 1)
  assert.equal(report.clean, false)
})

test('steps that only one side reaches, or reach in another order, are their own findings', () => {
  const report = diffTranscripts(
    [step('first'), step('second'), step('only on the baseline')],
    [step('second'), step('first'), step('only on the candidate')],
  )
  assert.deepEqual(report.missing, ['only on the baseline'])
  assert.deepEqual(report.added, ['only on the candidate'])
  assert.equal(report.moved.length, 2)
  assert.match(formatReport(report, { baseline: 'a', candidate: 'b' }), /Steps the candidate does not reach/)
})

test('the command line answers with the code a pipeline reads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-golden-'))
  const script = fileURLToPath(new URL('../dev/golden-diff.mjs', import.meta.url))
  const write = (name, value) => {
    const path = join(dir, name)
    writeFileSync(path, JSON.stringify(value))
    return path
  }
  try {
    const baseline = write('baseline.json', [step('a', { bots: [{ id: 'bot-1' }] })])
    const same = write('same.json', [step('a', { bots: [{ id: 'bot-2' }] })])
    const rules = write('rules.json', [{ path: 'state.bots.*.id' }])
    const report = join(dir, 'report.md')
    const clean = spawnSync(process.execPath, [script, baseline, same, '--mask', rules, '--out', report], { encoding: 'utf8' })
    assert.equal(clean.status, 0, clean.stderr)
    assert.match(readFileSync(report, 'utf8'), /difference: 0/)

    const drifted = write('drifted.json', [step('a', { bots: [{ id: 'bot-2', name: 'Chief' }] })])
    const dirty = spawnSync(process.execPath, [script, baseline, drifted], { encoding: 'utf8' })
    assert.equal(dirty.status, 1)
    assert.match(dirty.stdout, /\+ state\.bots\.0\.name: "Chief"/)

    const usage = spawnSync(process.execPath, [script], { encoding: 'utf8' })
    assert.equal(usage.status, 2)
    assert.match(usage.stderr, /usage: node dev\/golden-diff\.mjs/)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
