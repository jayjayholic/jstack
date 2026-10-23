export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = { id: string; subject: string; status: TaskStatus; active?: string }

export type Doing = { id: string; tool: string; detail: string; startedAt: number }

export type AgentRow = {
  id: string
  name: string
  type: string
  description: string
  status: string
  startedAt: number
  endedAt?: number
  tokens: number
}

export type Tone = 'success' | 'warning' | 'error'

export type Row = {
  label: string
  percent: number
  rate: string | null
  eta: string | null
  reset: string | null
  tone: Tone
  spark: string
  delta: number | null
  // One short status for a single panel line: "ok ↻16:40", "out Tue 01:54", "…".
  brief: string
}

// One thing using the context window, coloured as /context colours its category.
export type ContextItem = { label: string; tokens: number; color: string }

export type ContextView = {
  percent: number
  usedTokens: number
  maxTokens: number
  freeTokens: number
  // The used categories, in /context order, for the stacked bar.
  segments: ContextItem[]
  // The ten biggest consumers, with their share of what is used.
  top: (ContextItem & { share: number })[]
  // How many smaller consumers the top list leaves out.
  more: number
}

// One usage window of an account, as /api/oauth/usage reports it; `binding` marks the 5-hour and the
// all-models weekly window, the ones that stop the account.
export type UsageWindow = { key: string; label: string; percent: number; resetsAt: string | null; binding: boolean }

// `key` is `${email}#${organizationUuid}`: one email can hold several accounts, one per organization.
export type AccountView = {
  key: string
  email: string
  org: string
  tier: string
  windows: UsageWindow[]
  fetchedAt: number | null
  error: string | null
}

export type SwitchRecord = { from: string | null; to: string; at: number; reason: string }

export type SessionsView = {
  accounts: AccountView[]
  active: string | null
  autoSwitch: boolean
  refreshing: boolean
  lastSwitch: SwitchRecord | null
  notice: string | null
  // Why the last read of the store failed, shown in place of the list.
  error: string | null
  loadedAt: number | null
}

export type OAuthTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  refreshTokenExpiresAt?: number
  scopes?: string[]
  subscriptionType?: string
  rateLimitTier?: string
  [extra: string]: unknown
}

export type StoredAccount = {
  key?: string
  email: string
  savedAt: string
  oauthAccount: Record<string, unknown>
  claudeAiOauth: OAuthTokens
}

export type AccountStore = { accounts: StoredAccount[]; [extra: string]: unknown }

export type CurrentLogin = { key: string | null; email: string | null; oauthAccount: Record<string, unknown>; oauth: OAuthTokens | null }

export type SessionWindow = { kind: string; percentUsed: number; resetsAt?: string }

export type IoResponse = { status: number; ok: boolean; text: string; retryAfter?: string }

// An account whose last read failed is not asked again before `until`; `step` doubles per failure.
export type Backoff = { until: number; step: number }

// What a read asks for: no network at all, every account, or only these keys.
export type ReadWhich = 'none' | 'all' | readonly string[]

// Kept by the caller across reads: when each account was last asked, and which ones are backing off.
export type ReadSchedule = { readAt: Map<string, number>; backoff: Map<string, Backoff> }

export type IoRequest = { method?: string; headers?: Record<string, string>; body?: string }

export type AccountIo = {
  home: () => Promise<string>
  configDir?: () => Promise<string>
  now: () => Promise<number>
  exists: (path: string) => Promise<boolean>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  fetch: (url: string, init?: IoRequest) => Promise<IoResponse>
  sessionLimits: () => Promise<SessionWindow[]>
}

declare module 'claude-code' {
  interface PluginState {
    'jay-claude-switcher': {
      context: ContextView | null
      tasks: Task[]
      doing: Doing[]
      showDone: boolean
      agents: AgentRow[]
      now: number
      usage: Row[]
      sessions: SessionsView
    }
  }
}
