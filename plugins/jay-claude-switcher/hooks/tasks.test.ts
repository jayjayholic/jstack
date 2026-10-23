import { expect, test } from 'claude-code/testing'
import { created, detailOf, fromListText, fromTodos, updated } from './tasks'

test('TodoWrite replaces the list with its todos', () => {
  const list = fromTodos([
    { content: 'Write spec', status: 'completed', activeForm: 'Writing spec' },
    { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
  ])
  expect(list.map(t => t.status)).toEqual(['completed', 'in_progress'])
  expect(list[1]!.active).toBe('Running tests')
})

test('TaskCreate takes its id from the result text, and ignores a result without one', () => {
  const one = created([], 'Task #25 created successfully: Plan', 'Plan')
  expect(one).toEqual([{ id: '25', subject: 'Plan', status: 'pending' }])
  expect(created(one, 'no id here', 'Other')).toBe(one)
  expect(created(one, 'Task #25 created', 'Dup')).toBe(one)
})

test('TaskUpdate changes status, deletes, and adds an unknown id', () => {
  const base = created([], 'Task #1 created', 'A')
  expect(updated(base, { taskId: '1', status: 'completed' })[0]!.status).toBe('completed')
  expect(updated(base, { taskId: '1', status: 'deleted' })).toEqual([])
  expect(updated(base, { taskId: '9', status: 'in_progress' }).map(t => t.id)).toEqual(['1', '9'])
})

test('TaskList text rebuilds the list; unreadable text keeps it', () => {
  const text = '#17. [completed] Session memory\n#25. [in_progress] GraphRAG plan\n#27. [pending] Know-how test'
  const list = fromListText([], text)
  expect(list.map(t => [t.id, t.status])).toEqual([['17', 'completed'], ['25', 'in_progress'], ['27', 'pending']])
  const kept = created([], 'Task #1 created', 'A')
  expect(fromListText(kept, 'nothing')).toBe(kept)
})

test('detail picks the most telling input field and clips long ones', () => {
  expect(detailOf('Bash', { command: 'ls', description: 'List files' })).toBe('List files')
  expect(detailOf('Read', { file_path: 'C:/a.ts' })).toBe('C:/a.ts')
  expect(detailOf('X', {})).toBe('X')
  expect(detailOf('Bash', { command: 'x'.repeat(100) }).length).toBe(58)
})
