import type { Task, TaskStatus } from '../types'

type TodoInput = { content: string; status: TaskStatus; activeForm: string }
type UpdateInput = { taskId: string; subject?: string; activeForm?: string; status?: TaskStatus | 'deleted' }

// TodoWrite replaces the whole list.
function fromTodos(todos: readonly TodoInput[]): Task[] {
  return todos.map((t, i) => ({ id: `todo-${i}`, subject: t.content, status: t.status, active: t.activeForm }))
}

// TaskCreate's result text names the new id ("Task #25 created successfully: …").
function created(tasks: Task[], text: string | undefined, subject: string, active?: string): Task[] {
  const id = text?.match(/#(\d+)/)?.[1]
  if (!id || tasks.some(t => t.id === id)) return tasks
  return [...tasks, { id, subject, status: 'pending', ...(active ? { active } : {}) }]
}

function updated(tasks: Task[], input: UpdateInput): Task[] {
  const status = input.status
  if (status === 'deleted') return tasks.filter(t => t.id !== input.taskId)
  const known = tasks.some(t => t.id === input.taskId)
  const base = known ? tasks : [...tasks, { id: input.taskId, subject: input.subject ?? `#${input.taskId}`, status: 'pending' as const }]
  return base.map(t =>
    t.id === input.taskId
      ? {
          ...t,
          ...(input.subject ? { subject: input.subject } : {}),
          ...(input.activeForm ? { active: input.activeForm } : {}),
          ...(status ? { status } : {}),
        }
      : t,
  )
}

// TaskList's text ("#17. [completed] subject") is the source of truth when it arrives: rebuild from it.
function fromListText(tasks: Task[], text: string | undefined): Task[] {
  const rows = [...(text ?? '').matchAll(/#(\d+)\.?\s*\[(pending|in_progress|completed)\]\s*(.+)/g)]
  if (!rows.length) return tasks
  return rows.map(([, id, status, subject]) => {
    const prev = tasks.find(t => t.id === id)
    return { id: id!, subject: subject!.trim(), status: status as TaskStatus, ...(prev?.active ? { active: prev.active } : {}) }
  })
}

// A short, human description of what a tool call is doing.
function detailOf(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const raw =
    pick('description') || pick('file_path') || pick('pattern') || pick('url') || pick('query') || pick('command') || pick('prompt') || ''
  const short = raw.replace(/\s+/g, ' ').trim()
  return short.length > 60 ? `${short.slice(0, 57)}…` : short || tool
}

export { created, detailOf, fromListText, fromTodos, updated }
