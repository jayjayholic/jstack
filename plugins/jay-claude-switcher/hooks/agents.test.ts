import { expect, test } from 'claude-code/testing'
import { resumeLine, addUsage, formatDuration, formatTokens, isActive, mergeList, withoutStale } from './agents'

const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 800, cache_creation_input_tokens: 50 }

test('the engine list fills name, topic and status; finishing stamps the end once', () => {
  const one = mergeList([], [{ id: 'a1', type: 'general-purpose', description: 'Write doc', status: 'running' }], 1000)
  expect(one[0]).toMatchObject({ name: 'general-purpose', description: 'Write doc', startedAt: 1000 })
  const done = mergeList(one, [{ id: 'a1', type: 'general-purpose', description: 'Write doc', status: 'completed' }], 5000)
  expect(done[0]!.endedAt).toBe(5000)
  expect(mergeList(done, [{ id: 'a1', type: 'general-purpose', description: 'Write doc', status: 'completed' }], 9000)[0]!.endedAt).toBe(5000)
})

test('an agent the engine dropped is kept as finished', () => {
  const one = mergeList([], [{ id: 'a1', type: 't', description: 'd', status: 'running' }], 0)
  const gone = mergeList(one, [], 3000)
  expect(gone[0]).toMatchObject({ status: 'completed', endedAt: 3000 })
})

test('tokens add up per step, and steps of an unseen agent start its row', () => {
  const r = addUsage(addUsage([], 'x', usage, 10), 'x', usage, 20)
  expect(r).toHaveLength(1)
  expect(r[0]!.tokens).toBe(2000)
})

test('durations and tokens read like the footer', () => {
  expect(formatDuration(406_000)).toBe('6m 46s')
  expect(formatDuration(5_906_000)).toBe('1h 38m 26s')
  expect(formatDuration(-5)).toBe('0s')
  expect(formatTokens(184_600)).toBe('184.6k')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(2_500_000)).toBe('2.5M')
})

test('a completed agent leaves the panel at once; a failed one stays a minute; running ones stay', () => {
  const base = { name: 'a', type: 't', description: '', status: 'completed', startedAt: 0, tokens: 0 }
  const rows = [
    { ...base, id: 'done', endedAt: 69_000 },
    { ...base, id: 'old-fail', status: 'failed', endedAt: 1_000 },
    { ...base, id: 'recent-fail', status: 'failed', endedAt: 50_000 },
    { ...base, id: 'live', status: 'running' },
  ]
  expect(withoutStale(rows, 70_000).map(a => a.id)).toEqual(['recent-fail', 'live'])
  expect(withoutStale(rows, 200_000).map(a => a.id)).toEqual(['live'])
  expect(withoutStale([], 0)).toEqual([])
})

test('only a loop mid-turn counts as running; waiting and idle agents are parked', () => {
  const base = { name: 'a', type: 't', description: '', startedAt: 0, tokens: 0 }
  expect(isActive({ ...base, id: 'r', status: 'running' })).toBe(true)
  expect(isActive({ ...base, id: 'w', status: 'waiting' })).toBe(false)
  expect(isActive({ ...base, id: 'i', status: 'idle' })).toBe(false)
  expect(isActive({ ...base, id: 'c', status: 'running', endedAt: 5 })).toBe(false)
})

test('a resumed agent is live again', () => {
  const ended = [{ id: 'x', name: 'x', type: 't', description: '', status: 'completed', startedAt: 0, tokens: 0, endedAt: 10 }]
  const [row] = mergeList(ended, [{ id: 'x', type: 't', description: '', status: 'running' }], 20)
  expect(row!.endedAt).toBeUndefined()
  expect(row!.status).toBe('running')
})

test('after a limit error the status names where the session went and who to resume, main conversation first', () => {
  expect(resumeLine('b@example.com [Org]', true, ['writer', 'tester', 'writer'])).toBe('Limit hit, now on b@example.com [Org]. Resume: the main conversation, @writer, @tester')
  expect(resumeLine('b@example.com', false, [])).toBe('Limit hit, now on b@example.com.')
  expect(resumeLine(null, false, ['writer'])).toBe('Limit hit, no account to switch to. Resume: @writer')
})
