// The values the statusline mod keeps in `$.state`, under its own name.

/** The machine's appearance, which the desktop app follows; null where it could not be read. */
export type Appearance = 'light' | 'dark' | null

/** One rate-limit window as the engine reports it. */
export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** What `git status` says about the session's directory. */
export type GitInfo = {
  /** The branch, or `@<sha>` when HEAD is detached. */
  branch: string
  /** The linked worktree's folder name; null in the main working tree. */
  worktree: string | null
  isDirty: boolean
  ahead: number
  behind: number
}

/** Everything the band draws, taken in one pass at a known moment. */
export type Snapshot = {
  /** When the snapshot was taken, in `$.clock.now()` milliseconds. */
  at: number
  /** When the session began, in the same milliseconds. */
  startedAt: number
  model: string
  /** The engine's version, as `claude --version` prints it. */
  version: string
  /** The desktop app's version, in a session it started; null elsewhere. */
  appVersion: string | null
  /** The session's project root and current directory, absolute. */
  root: string
  cwd: string
  /** The person's home directory, shortened to `~` in the project cell. */
  home: string
  /** The Theme setting (`dark`, `light`, `auto`, ...), which picks the palette on the terminal. */
  theme: string
  /** The machine's appearance, which picks the palette on the desktop. */
  appearance: Appearance
  contextPercent: number | null
  inputTokens: number | null
  rateLimits: RateLimit[]
  costUsd: number | null
  git: GitInfo | null
}

/** Running totals the mod counts itself, since the engine reports none. */
export type Counters = {
  linesAdded: number
  linesRemoved: number
  outputTokens: number
  /** Milliseconds spent waiting on model requests. */
  apiMs: number
}

declare module 'claude-code' {
  interface PluginState {
    statusline: { snapshot: Snapshot | null; counters: Counters; isHidden: boolean; isDemo: boolean }
  }
}
