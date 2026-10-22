// statusline: the claude-statusline script as a mod. Draws the band above the
// prompt with four rows of three columns:
//
//   Context bar      | Model    | 5h rate limit
//   Project dir      | Version  | 7d rate limit
//   Lines changed    | Worktree | Git branch
//   Session duration | Tokens   | Cost
//
// The figures come from `$.session.usage()` (context, rate limits, cost), the
// session nouns (model, version, directories) and two git commands; the mod
// counts for itself what the engine does not report (lines changed, output
// tokens, time spent on model requests). Each cell renders nothing when its
// data is absent, as the script's do.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { Appearance, Counters, GitInfo, Snapshot } from '../types'

// =====================
// Configuration
// =====================

type Layout = { col1: number; col2: number; ctxBar: number; rateBar: number }

/** `catppuccin` follows the Theme setting (Latte on a light one, Mocha on a dark one); the others force a look. */
type ThemeOption = 'catppuccin' | 'catppuccin-mocha' | 'catppuccin-latte' | 'default'
const THEME_OPTIONS: readonly ThemeOption[] = ['catppuccin', 'catppuccin-mocha', 'catppuccin-latte', 'default']

const themeOf = (options: PluginOptions): ThemeOption =>
  THEME_OPTIONS.find(one => one === options.theme) ?? 'catppuccin'

/**
 * When a one-line summary is also pinned under the prompt, as the plugin's
 * status line: with a desktop surface attached (the app hides the band
 * behind its next-step box), always, or never.
 */
type StatusLineOption = 'desktop' | 'always' | 'off'
const STATUS_LINE_OPTIONS: readonly StatusLineOption[] = ['desktop', 'always', 'off']

const statusLineOf = (options: PluginOptions): StatusLineOption =>
  STATUS_LINE_OPTIONS.find(one => one === options.statusLine) ?? 'desktop'

const numberOption = (value: unknown, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const layoutOf = (options: PluginOptions): Layout => ({
  col1: numberOption(options.col1Width, 40),
  col2: numberOption(options.col2Width, 40),
  ctxBar: numberOption(options.contextBarWidth, 25),
  rateBar: numberOption(options.rateBarWidth, 20),
})

/** How often the band is redrawn with nothing else going on: the countdowns move by the minute. */
const TICK_MS = 60_000
/** How long after a tool call the git cells are read again, so a burst of edits reads once. */
const SETTLE_MS = 500
const GIT_TIMEOUT_MS = 10_000
/** Past this many edit steps between two versions of a file the count is approximate. */
const MAX_DIFF_STEPS = 2_000
/** A bar shorter than this says nothing: below it the grid reflows instead. */
const MIN_BAR = 8
/** The second column holds "in: 123.4k out: 12.3k tokens" at the least. */
const MIN_COL2 = 24

const COMMAND = 'statusband'
/** The inspect tool's full name, matched as a pattern: a tool of the mod's own is not in the table a literal is held to. */
const INSPECT_TOOL = /^mcp__statusline__inspect$/
const HIDDEN_KEY = 'isHidden'

// =====================
// Colors: one palette per theme, each cell colored by its role
// =====================

type Palette = {
  /** "Context:", "Model:", ... ; absent, the surface's own text color. */
  label?: string
  /** Plain values and the words beside them; absent, the surface's own. */
  value?: string
  /** The countdown after a rate-limit bar. */
  muted?: string
  /** Model and version. */
  accent: string
  /** The git branch. */
  branch: string
  /** The project directory. */
  path: string
  /** The worktree and the ahead/behind arrows. */
  note: string
  /** The cost. */
  money: string
  /** Lines added, and a bar under 50 %. */
  good: string
  /** A bar from 50 %. */
  warn: string
  /** Lines removed, the dirty marker, and a bar from 80 %. */
  bad: string
  /** The unfilled part of a bar; absent, the fill's own color, as the script draws it. */
  track?: string
}

/** The script's colors: theme keys where the color had a meaning, raw names elsewhere. */
const DEFAULT_PALETTE: Palette = {
  accent: 'cyan',
  branch: 'cyan',
  path: 'blue',
  note: 'warning',
  money: 'warning',
  good: 'success',
  warn: 'warning',
  bad: 'error',
}

/** Catppuccin Mocha, for a dark theme. */
const MOCHA: Palette = {
  label: '#a6adc8', // subtext0
  value: '#cdd6f4', // text
  muted: '#9399b2', // overlay2
  accent: '#74c7ec', // sapphire
  branch: '#94e2d5', // teal
  path: '#89b4fa', // blue
  note: '#fab387', // peach
  money: '#f9e2af', // yellow
  good: '#a6e3a1', // green
  warn: '#f9e2af', // yellow
  bad: '#f38ba8', // red
  track: '#585b70', // surface2
}

/** Catppuccin Latte, for a light theme. */
const LATTE: Palette = {
  label: '#6c6f85', // subtext0
  value: '#4c4f69', // text
  muted: '#7c7f93', // overlay2
  accent: '#209fb5', // sapphire
  branch: '#179299', // teal
  path: '#1e66f5', // blue
  note: '#fe640b', // peach
  money: '#df8e1d', // yellow
  good: '#40a02b', // green
  warn: '#df8e1d', // yellow
  bad: '#d20f39', // red
  track: '#acb0be', // surface2
}

/**
 * The palette for the option and where the band is drawn. On the desktop,
 * `appearance` says what the app draws on where it could be read; the
 * terminal follows the Theme setting (`light*` is light; `auto` counts as
 * dark).
 */
const paletteOf = (option: ThemeOption, theme: string, appearance: Appearance, surface: string): Palette => {
  if (option === 'default') return DEFAULT_PALETTE
  if (option === 'catppuccin-latte') return LATTE
  if (option === 'catppuccin-mocha') return MOCHA
  const isLight = surface === 'desktop' && appearance !== null ? appearance === 'light' : theme.startsWith('light')
  return isLight ? LATTE : MOCHA
}

// =====================
// State: what the band draws from, held by the host so a hot reload keeps it
// =====================

const NO_COUNTERS: Counters = { linesAdded: 0, linesRemoved: 0, outputTokens: 0, apiMs: 0 }

const snapshot = atom({ plugin: 'statusline', key: 'snapshot' } as const, null)
const counters = atom({ plugin: 'statusline', key: 'counters' } as const, NO_COUNTERS)
const isHidden = atom({ plugin: 'statusline', key: 'isHidden' } as const, false)
const isDemo = atom({ plugin: 'statusline', key: 'isDemo' } as const, false)

// =====================
// Demo: made-up figures that fill every cell, for screenshots
// =====================

const DEMO_COUNTERS: Counters = { linesAdded: 128, linesRemoved: 41, outputTokens: 45_600, apiMs: 12 * 60_000 + 40_000 }

/** The snapshot's figures replaced by the demo's; the theme, appearance and version stay the real ones. */
const demoFigures = (now: number, home: string): Partial<Snapshot> => ({
  startedAt: now - (83 * 60_000 + 7_000),
  model: 'claude-opus-5-5',
  root: `${home || '/Users/me'}/workspace/claude-mods`,
  contextPercent: 62,
  inputTokens: 1_234_567,
  rateLimits: [
    { kind: 'five_hour', percentUsed: 81, resetsAt: new Date(now + 2 * 3_600_000 + 15 * 60_000).toISOString() },
    { kind: 'seven_day', percentUsed: 34, resetsAt: new Date(now + 3 * 86_400_000 + 5 * 3_600_000).toISOString() },
  ],
  costUsd: 12.34,
  git: { branch: 'feature/login', worktree: 'claude-mods-login', isDirty: true, ahead: 2, behind: 1 },
})

// =====================
// Render primitives: a cell is a list of spans, empty when its data is absent
// =====================

type Span = { text: string; color?: string }
type Cell = Span[]

const plain = (text: string): Span => ({ text })
const colored = (text: string, color: string): Span => ({ text, color })

/** A span in the palette's color for the role; plain where the palette names none. */
const inRole = (text: string, color: string | undefined): Span => (color === undefined ? plain(text) : colored(text, color))

/** "name: value" pair, the value colored when asked. */
const label = (palette: Palette, name: string, value: string, color?: string): Cell => [
  inRole(`${name}: `, palette.label),
  inRole(value, color),
]

/** Cells the cell takes on screen: every glyph the band draws is one cell wide. */
const widthOf = (cell: Cell): number => cell.reduce((n, span) => n + Array.from(span.text).length, 0)

/** Progress bar colored by threshold: green < 50 <= yellow < 80 <= red. */
const bar = (palette: Palette, pct: number, width: number): Span[] => {
  const filled = Math.max(0, Math.min(width, Math.floor((pct * width) / 100)))
  const color = pct >= 80 ? palette.bad : pct >= 50 ? palette.warn : palette.good
  return [colored('━'.repeat(filled), color), colored('─'.repeat(width - filled), palette.track ?? color)].filter(span => span.text !== '')
}

const labeledBar = (palette: Palette, name: string, pct: number, width: number): Cell => [
  inRole(`${name}: `, palette.label),
  ...bar(palette, pct, width),
  plain(` ${String(pct).padStart(3)}%`),
]

/** 1234567 → "1.2M", 12345 → "12.3k". */
const fmtNum = (n: number): string => {
  if (n >= 1_000_000) return `${Math.floor(n / 1_000_000)}.${Math.floor((n % 1_000_000) / 100_000)}M`
  if (n >= 1000) return `${Math.floor(n / 1000)}.${Math.floor((n % 1000) / 100)}k`
  return `${Math.floor(n)}`
}

/** 5400000 (ms) → "1h 30m". */
const fmtDuration = (ms: number): string => {
  const secs = Math.max(0, Math.floor(ms / 1000))
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
  if (secs >= 60) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${secs}s`
}

/** Seconds until a reset → "(2d 3h)" / "(7h 56m)"; nothing when past. */
const fmtRemaining = (secs: number): string => {
  if (secs <= 0) return ''
  const days = Math.floor(secs / 86400)
  const hours = Math.floor((secs % 86400) / 3600)
  const mins = Math.floor((secs % 3600) / 60)
  return days > 0 ? `(${days}d ${hours}h)` : `(${hours}h ${mins}m)`
}

/** ISO 8601, or epoch seconds or milliseconds → seconds from `now`; null when unreadable. */
const secondsUntil = (resetsAt: string | number | undefined, now: number): number | null => {
  if (resetsAt === undefined || resetsAt === '') return null
  let epochMs: number
  if (typeof resetsAt === 'number' || /^\d+(\.\d+)?$/.test(resetsAt)) {
    let epoch = Number(resetsAt)
    if (epoch > 32_503_680_000) epoch /= 1000
    epochMs = epoch * 1000
  } else {
    epochMs = Date.parse(resetsAt)
  }
  return Number.isFinite(epochMs) ? Math.floor((epochMs - now) / 1000) : null
}

/**
 * The model as the status line names it: `claude-fable-5-1` → "Fable 5.1",
 * `claude-sonnet-4-5-20250929` → "Sonnet 4.5"; any other spelling as it came.
 */
const displayModel = (model: string): string => {
  const match = /^claude-([a-z0-9-]+?)(?:-\d{8})?(\[\w+\])?$/i.exec(model)
  if (match === null) return model
  const parts = (match[1] ?? '').split('-')
  const words: string[] = []
  for (const part of parts) {
    const last = words.length - 1
    if (/^\d+$/.test(part) && last >= 0 && /^\d+(\.\d+)*$/.test(words[last] ?? '')) words[last] = `${words[last]}.${part}`
    else words.push(/^\d+$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1))
  }
  return `${words.join(' ')}${match[2] ? ` ${match[2]}` : ''}`
}

const basename = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const tildify = (path: string, home: string): string =>
  home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

// =====================
// Cells
// =====================

const rateCell = (palette: Palette, name: string, kind: string, snap: Snapshot, layout: Layout): Cell => {
  const limit = snap.rateLimits.find(one => one.kind === kind)
  if (limit === undefined) return []
  const remaining = secondsUntil(limit.resetsAt, snap.at)
  const tail = remaining === null ? '' : fmtRemaining(remaining)
  return [...labeledBar(palette, name, Math.round(limit.percentUsed), layout.rateBar), ...(tail ? [inRole(` ${tail}`, palette.muted)] : [])]
}

const branchCell = (palette: Palette, git: GitInfo | null): Cell => {
  if (git === null || git.branch === '') return []
  const cell = label(palette, 'branch', git.branch, palette.branch)
  if (git.isDirty) cell.push(colored('*', palette.bad))
  const arrows = [git.ahead > 0 ? `↑${git.ahead}` : '', git.behind > 0 ? `↓${git.behind}` : ''].filter(Boolean).join(' ')
  if (arrows) cell.push(plain(' '), colored(arrows, palette.note))
  return cell
}

/** The engine's version and, in a session the desktop app started, the app's. */
const versionCell = (palette: Palette, snap: Snapshot): Cell => {
  const cell = label(palette, 'Version', snap.version, palette.accent)
  if (snap.appVersion) cell.push(inRole(` (app ${snap.appVersion})`, palette.muted))
  return cell
}

const sessionCell = (palette: Palette, snap: Snapshot, count: Counters): Cell => {
  const cell = label(palette, 'session', fmtDuration(snap.at - snap.startedAt))
  if (count.apiMs > 0) cell.push(plain(` (api: ${fmtDuration(count.apiMs)})`))
  return cell
}

const tokensCell = (palette: Palette, snap: Snapshot, count: Counters): Cell => {
  if (snap.inputTokens === null && count.outputTokens === 0) return []
  return [...label(palette, 'in', fmtNum(snap.inputTokens ?? 0)), plain(' '), ...label(palette, 'out', fmtNum(count.outputTokens)), plain(' tokens')]
}

/** The grid as the script lays it out: four rows, three columns. */
const gridOf = (palette: Palette, snap: Snapshot, count: Counters, layout: Layout): Cell[][] => [
  [
    snap.contextPercent === null ? [] : labeledBar(palette, 'Context', Math.round(snap.contextPercent), layout.ctxBar),
    snap.model === '' ? [] : label(palette, 'Model', displayModel(snap.model), palette.accent),
    rateCell(palette, '5h', 'five_hour', snap, layout),
  ],
  [
    snap.root === '' ? [] : [colored(tildify(snap.root, snap.home), palette.path)],
    snap.version === '' ? [] : versionCell(palette, snap),
    rateCell(palette, '7d', 'seven_day', snap, layout),
  ],
  [
    [colored(`+${count.linesAdded}`, palette.good), plain(' '), colored(`-${count.linesRemoved}`, palette.bad), plain(' lines')],
    snap.git?.worktree ? label(palette, 'wt', snap.git.worktree, palette.note) : [],
    branchCell(palette, snap.git),
  ],
  [
    sessionCell(palette, snap, count),
    tokensCell(palette, snap, count),
    snap.costUsd === null ? [] : [colored(`cost: $${snap.costUsd.toFixed(2)}`, palette.money)],
  ],
]

/**
 * The band in one line, for the plugin's status line under the prompt: it
 * stays where the band cannot be drawn (the desktop hides the band behind
 * its own next-step box). Text alone, no colors.
 */
const compactLineOf = (snap: Snapshot, count: Counters): string => {
  const parts: string[] = []
  if (snap.contextPercent !== null) parts.push(`Context ${Math.round(snap.contextPercent)}%`)
  for (const [name, kind] of [['5h', 'five_hour'], ['7d', 'seven_day']] as const) {
    const limit = snap.rateLimits.find(one => one.kind === kind)
    if (limit === undefined) continue
    const remaining = secondsUntil(limit.resetsAt, snap.at)
    const tail = remaining === null ? '' : fmtRemaining(remaining)
    parts.push(`${name} ${Math.round(limit.percentUsed)}%${tail ? ` ${tail}` : ''}`)
  }
  if (snap.git !== null && snap.git.branch !== '') {
    const arrows = [snap.git.ahead > 0 ? `↑${snap.git.ahead}` : '', snap.git.behind > 0 ? `↓${snap.git.behind}` : ''].filter(Boolean).join(' ')
    parts.push(`${snap.git.worktree ? `${snap.git.worktree} ` : ''}${snap.git.branch}${snap.git.isDirty ? '*' : ''}${arrows ? ` ${arrows}` : ''}`)
  }
  parts.push(`+${count.linesAdded} -${count.linesRemoved}`)
  if (snap.costUsd !== null) parts.push(`$${snap.costUsd.toFixed(2)}`)
  return parts.join(' · ')
}

// =====================
// Layout: the script's grid wherever it can be made to fit
// =====================

type Fit = { columns: 1 | 2 | 3; layout: Layout }

/** The widest rate cell: "5h: ", the bar, " 100%" and " (2d 23h)". */
const rateCellWidth = (rateBar: number): number => rateBar + 18

/**
 * Three columns where they fit, at the script's widths, or narrowed together
 * with the bars while the bars stay readable; else two columns, or one.
 */
const fitOf = (layout: Layout, bodyColumns: number): Fit => {
  const width = Number.isFinite(bodyColumns) && bodyColumns > 0 ? bodyColumns : Number.POSITIVE_INFINITY
  const needed = layout.col1 + layout.col2 + rateCellWidth(layout.rateBar)
  if (width >= needed) return { columns: 3, layout }
  const scale = width / needed
  const col1 = Math.floor(layout.col1 * scale)
  const col2 = Math.floor(layout.col2 * scale)
  // "Context: " and " 100%" around the bar, and a cell of separation
  const ctxBar = Math.min(layout.ctxBar, col1 - 15)
  const rateBar = Math.min(layout.rateBar, width - col1 - col2 - 18)
  if (ctxBar >= MIN_BAR && rateBar >= MIN_BAR && col2 >= MIN_COL2) {
    return { columns: 3, layout: { col1, col2, ctxBar, rateBar } }
  }
  return { columns: width >= layout.col1 + 40 ? 2 : 1, layout }
}

/** The rows to draw: the grid with its blank rows dropped, or its cells reflowed. */
const rowsOf = (grid: Cell[][], columns: 1 | 2 | 3): Cell[][] => {
  if (columns === 3) return grid.filter(row => row.some(cell => cell.length > 0))
  const cells = grid.flat().filter(cell => cell.length > 0)
  const rows: Cell[][] = []
  for (let i = 0; i < cells.length; i += columns) rows.push(cells.slice(i, i + columns))
  return rows
}

// =====================
// Git info: one rev-parse for the repo shape, one status for the rest
// =====================

const git = ($: EngineInterface, cwd: string, args: string[]) =>
  $.process.run(['git', '--no-optional-locks', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })

/** Null outside a repository; undefined where the host runs no commands. */
const readGitByCommand = async ($: EngineInterface, cwd: string): Promise<GitInfo | null | undefined> => {
  let shape
  try {
    shape = await git($, cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])
  } catch {
    return undefined
  }
  if (shape.exitCode !== 0) return null
  // In a linked worktree --git-dir points inside .git/worktrees/, while
  // --git-common-dir keeps pointing to the main .git.
  const [gitDir = '', commonDir = '', topLevel = ''] = shape.stdout.trim().split('\n')
  const info: GitInfo = {
    branch: '',
    worktree: gitDir !== '' && gitDir !== commonDir ? basename(topLevel) : null,
    isDirty: false,
    ahead: 0,
    behind: 0,
  }

  let status
  try {
    status = await git($, cwd, ['status', '--porcelain=v2', '--branch'])
  } catch {
    return info
  }
  if (status.exitCode !== 0) return info

  // Headers come first, so the first non-header line means a dirty tree.
  let sha = ''
  for (const line of status.stdout.split('\n')) {
    if (line === '') continue
    if (!line.startsWith('# ')) {
      info.isDirty = true
      break
    }
    const [, key = '', a = '', b = ''] = line.split(' ')
    if (key === 'branch.oid') sha = a.slice(0, 7)
    else if (key === 'branch.head') info.branch = a // "(detached)" when not on a branch
    else if (key === 'branch.ab') {
      info.ahead = Number(a.replace('+', '')) || 0
      info.behind = Number(b.replace('-', '')) || 0
    }
  }
  if (info.branch === '(detached)') info.branch = `@${sha}`
  return info
}

/** The branch alone, read from .git/HEAD, where no command can run. */
const readGitByFiles = async ($: EngineInterface, cwd: string): Promise<GitInfo | null> => {
  try {
    let dir = cwd
    for (let depth = 0; depth < 64; depth++) {
      const dotGit = `${dir}/.git`
      if (await $.fs.exists(dotGit)) {
        let gitDir = dotGit
        let worktree: string | null = null
        if ((await $.fs.stat(dotGit)).kind === 'file') {
          const pointer = /^gitdir:\s*(.+)$/m.exec(await $.fs.read(dotGit))
          if (pointer === null) return null
          gitDir = pointer[1]?.trim() ?? ''
          if (!gitDir.startsWith('/')) gitDir = `${dir}/${gitDir}`
          if (gitDir.includes('/worktrees/')) worktree = basename(dir)
        }
        const head = (await $.fs.read(`${gitDir}/HEAD`)).trim()
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
        return { branch: ref?.[1] ?? `@${head.slice(0, 7)}`, worktree, isDirty: false, ahead: 0, behind: 0 }
      }
      const parent = dir.slice(0, dir.lastIndexOf('/')) || '/'
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // unreadable: no git cells
  }
  return null
}

const readGit = async ($: EngineInterface, cwd: string): Promise<GitInfo | null> => {
  const byCommand = await readGitByCommand($, cwd)
  return byCommand === undefined ? readGitByFiles($, cwd) : byCommand
}

// =====================
// Appearance: what the desktop app draws on
// =====================

/** Where the desktop app keeps its settings, per system; the first that exists is read. */
const appConfigPaths = (home: string, appData: string | undefined): string[] => [
  `${home}/Library/Application Support/Claude/config.json`,
  ...(appData ? [`${appData}/Claude/config.json`] : []),
  `${home}/.config/Claude/config.json`,
]

/**
 * The app's own Appearance setting, `userThemeMode` in its config file:
 * `light` or `dark`; null when it follows the system, or cannot be read.
 */
const readAppThemeMode = async ($: EngineInterface, home: string, appData: string | undefined): Promise<Appearance> => {
  for (const path of appConfigPaths(home, appData)) {
    try {
      if (!(await $.fs.exists(path))) continue
      const mode = (JSON.parse(await $.fs.read(path)) as { userThemeMode?: unknown }).userThemeMode
      return mode === 'light' || mode === 'dark' ? mode : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * macOS keeps `AppleInterfaceStyle` only while in dark mode: the key read is
 * dark, the key missing (a failing read) is light. Null where the command
 * cannot run (another system, no host commands).
 */
const readSystemAppearance = async ($: EngineInterface): Promise<Appearance> => {
  try {
    const read = await $.process.run(['defaults', 'read', '-g', 'AppleInterfaceStyle'], { timeoutMs: 5_000 })
    return read.exitCode === 0 && read.stdout.trim().toLowerCase() === 'dark' ? 'dark' : 'light'
  } catch {
    return null
  }
}

/** The app's own setting first, the system's where the app follows it; null leaves it to the Theme setting. */
const readAppearance = async ($: EngineInterface, home: string, appData: string | undefined): Promise<Appearance> =>
  (await readAppThemeMode($, home, appData)) ?? readSystemAppearance($)

// =====================
// Lines changed: the two versions of an edited file, diffed by line
// =====================

/** Myers' edit distance between two line lists; null past `maxSteps`. */
const editDistance = (a: readonly string[], b: readonly string[], maxSteps: number): number | null => {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return 0
  const v = new Int32Array(2 * max + 2)
  for (let d = 0; d <= Math.min(max, maxSteps); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[k - 1 + max] ?? 0) < (v[k + 1 + max] ?? 0)) ? (v[k + 1 + max] ?? 0) : (v[k - 1 + max] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[k + max] = x
      if (x >= n && y >= m) return d
    }
  }
  return null
}

/** Lines added and removed between two versions of a file. */
const countChanges = (before: readonly string[], after: readonly string[]): { added: number; removed: number } => {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let endA = before.length
  let endB = after.length
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--
    endB--
  }
  const a = before.slice(start, endA)
  const b = after.slice(start, endB)
  const steps = editDistance(a, b, MAX_DIFF_STEPS)
  if (steps === null) return { added: b.length, removed: a.length }
  return { added: (steps + b.length - a.length) / 2, removed: (steps - b.length + a.length) / 2 }
}

/** The file's lines; [] when it does not exist yet, null when it cannot be read. */
const linesOf = async ($: EngineInterface, path: string): Promise<string[] | null> => {
  try {
    if (!(await $.fs.exists(path))) return []
    const lines = (await $.fs.read(path)).split('\n')
    if (lines.at(-1) === '') lines.pop()
    return lines
  } catch {
    return null
  }
}

// =====================
// Refreshing: one snapshot at a time, from any event or timer
// =====================
// Module variables start over on a hot reload; what the band draws from is in
// `$.state`, so only these transient flags, the options and the last drawing's
// report live here.

type RenderReport = {
  surface: string
  bodyColumns: number
  maxRows: number
  viewport: { columns: number; rows: number } | null
  isDrawn: boolean
  hasSurvey: boolean
  columns: number
  layout: Layout
  rows: number
  /** How many asks since the load came with a survey holding the band. */
  surveys: number
}

let layout: Layout = layoutOf({})
let themeOption: ThemeOption = themeOf({})
let statusLineOption: StatusLineOption = statusLineOf({})
let running: Promise<void> | null = null
let refreshAgain = false
let settle: Timer | null = null
let lastRender: RenderReport | null = null
let surveyAsks = 0

const takeSnapshot = async ($: EngineInterface): Promise<void> => {
  const [usage, model, version, root, cwd, home, appData, appVersion, now, config] = await Promise.all([
    $.session.usage(),
    $.session.model(),
    $.session.version(),
    $.session.root(),
    $.session.cwd(),
    $.env.get('HOME'),
    $.env.get('APPDATA'),
    $.env.get('CLAUDE_CODE_DESKTOP_APP_VERSION'),
    $.clock.now(),
    $.config.list(),
  ])
  const next: Snapshot = {
    at: now,
    startedAt: usage.startedAt,
    model,
    version: version.version,
    appVersion: appVersion ?? null,
    root,
    cwd,
    home: home ?? '',
    theme: String(config.find(row => row.key === 'theme')?.value ?? 'dark'),
    appearance: await readAppearance($, home ?? '', appData),
    contextPercent: usage.context.percent ?? null,
    inputTokens: usage.context.tokens ?? null,
    rateLimits: usage.rateLimits.map(one => ({ kind: one.kind, percentUsed: one.percentUsed, resetsAt: one.resetsAt })),
    costUsd: usage.cost?.usd ?? null,
    git: await readGit($, cwd),
  }
  const demo = await read($, isDemo)
  await update($, snapshot, () => (demo ? { ...next, ...demoFigures(now, next.home) } : next))
}

/** The running totals, or the demo's while it is on. */
const countersOf = async ($: EngineInterface): Promise<Counters> => ((await read($, isDemo)) ? DEMO_COUNTERS : read($, counters))

/** Pins the one-line summary under the prompt, or clears it while the band is hidden or the line is not wanted. */
const pinStatusLine = async ($: EngineInterface): Promise<void> => {
  const [snap, count, hidden, surfaces] = await Promise.all([read($, snapshot), countersOf($), read($, isHidden), $.session.surfaces()])
  const isWanted = statusLineOption === 'always' || (statusLineOption === 'desktop' && surfaces.includes('desktop'))
  $.ui.status(isWanted && !hidden && snap !== null ? compactLineOf(snap, count) : undefined)
}

/**
 * Takes a snapshot; a call made while one is taken queues one more and
 * resolves with it, so the caller's change is in the snapshot it sees.
 */
const refresh = ($: EngineInterface): Promise<void> => {
  if (running !== null) {
    refreshAgain = true
    return running
  }
  running = (async () => {
    try {
      do {
        refreshAgain = false
        await takeSnapshot($)
      } while (refreshAgain)
      await pinStatusLine($)
    } catch (error) {
      $.ui.log(`statusline: refresh failed: ${String(error)}`, { to: 'debug' })
    } finally {
      running = null
    }
  })()
  return running
}

/** Refreshes once the tool calls have settled. */
const refreshSoon = ($: EngineInterface): void => {
  settle?.cancel()
  settle = $.clock.after(SETTLE_MS, () => {
    settle = null
    void refresh($)
  })
}

/** Adds to the running totals. */
const add = ($: EngineInterface, change: Partial<Counters>): Promise<Counters> =>
  update($, counters, count => ({
    linesAdded: count.linesAdded + (change.linesAdded ?? 0),
    linesRemoved: count.linesRemoved + (change.linesRemoved ?? 0),
    outputTokens: count.outputTokens + (change.outputTokens ?? 0),
    apiMs: count.apiMs + (change.apiMs ?? 0),
  }))

// =====================
// Hooks
// =====================

export const register: Register = (on, options) => {
  layout = layoutOf(options)
  themeOption = themeOf(options)
  statusLineOption = statusLineOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Shows, hides or refreshes the status band above the prompt; demo fills it with made-up figures, live brings the real ones back.',
      argumentHint: '[on|off|refresh|demo|live]',
    })
    await $.tool.register({
      name: 'inspect',
      description:
        'Reports what the statusline band last drew (surface, width in cells, columns chosen, rows) and the figures it holds. With `demo` true the band shows made-up figures that fill every cell (for screenshots); false brings the real ones back. Otherwise it changes nothing.',
      inputSchema: {
        type: 'object',
        properties: { demo: { type: 'boolean', description: 'Turn the demo figures on or off before reporting.' } },
      },
    })
    try {
      if ((await $.store.get(HIDDEN_KEY)) === true) await update($, isHidden, () => true)
    } catch {
      // no store: the band shows
    }
    const started = await next(e)
    void refresh($)
    $.clock.every(TICK_MS, () => void refresh($))
    return started
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'refresh') {
      await refresh($)
      return { text: 'Status band refreshed.' }
    }
    if (arg === 'demo' || arg === 'live') {
      await update($, isDemo, () => arg === 'demo')
      await refresh($)
      return { text: arg === 'demo' ? `Status band showing demo figures; /${COMMAND} live brings the real ones back.` : 'Status band showing the real figures.' }
    }
    const hide = arg === 'off' ? true : arg === 'on' ? false : !(await read($, isHidden))
    await update($, isHidden, () => hide)
    try {
      await $.store.set(HIDDEN_KEY, hide)
    } catch {
      // the choice holds for this session
    }
    await pinStatusLine($)
    return { text: hide ? `Status band hidden; /${COMMAND} on shows it again.` : 'Status band shown.' }
  }).catch(() => ({ text: 'statusline: the command failed; the debug log says why.' }))

  on('tool.call', { tool: INSPECT_TOOL }, async ($, e) => {
    const { demo } = e as unknown as { demo?: unknown }
    if (typeof demo === 'boolean') {
      await update($, isDemo, () => demo)
      await refresh($)
    }
    const [snap, count, hidden, isDemoOn] = await Promise.all([read($, snapshot), countersOf($), read($, isHidden), read($, isDemo)])
    const options = { ...layout, theme: themeOption, statusLine: statusLineOption }
    // A tool's result is text (or content blocks): the report as JSON.
    return { result: JSON.stringify({ lastRender, options, isHidden: hidden, isDemo: isDemoOn, snapshot: snap, counters: count }, null, 2) }
  }).catch(() => ({ deny: 'statusline: the inspect tool failed; the debug log says why.' }))

  // A change of the Theme setting changes the palette.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    refreshSoon($)
    return set
  })

  // The engine measures the session after each main-thread turn and when a
  // rate-limit window moves: the figures are read again then.
  on('session.measure', ($, e, next) => {
    refreshSoon($)
    return next(e)
  })

  // Output tokens, summed over every turn, main loop and subagents alike.
  on('turn.complete', async ($, e, next) => {
    const outputTokens = e.usage?.output_tokens ?? 0
    if (outputTokens > 0) await add($, { outputTokens })
    return next(e)
  })

  // Time spent on model requests: from the request to the end of its stream.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    try {
      return yield* next(e)
    } finally {
      try {
        const apiMs = (await $.clock.now()) - startedAt
        if (apiMs > 0) await add($, { apiMs })
      } catch {
        // the dispatch was abandoned: nothing to count
      }
    }
  })

  // Lines changed: the file before and after each edit tool runs; and the git
  // cells read again after anything that may have touched the working tree.
  on('tool.call', async ($, e, next) => {
    const path = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : null
    const before = path === null ? null : await linesOf($, path)
    const ran = await next(e)
    if (path !== null && before !== null && ran.deny === undefined && ran.isError !== true) {
      const after = await linesOf($, path)
      if (after !== null) {
        const { added, removed } = countChanges(before, after)
        if (added > 0 || removed > 0) await add($, { linesAdded: added, linesRemoved: removed })
      }
    }
    if (path !== null || e.tool === 'Bash') refreshSoon($)
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const report = (isDrawn: boolean, fit: Fit, rows: number): void => {
      lastRender = {
        surface: e.surface,
        bodyColumns: e.props.bodyColumns,
        maxRows: e.props.maxRows,
        viewport: e.viewport ? { columns: e.viewport.columns, rows: e.viewport.rows } : null,
        isDrawn,
        hasSurvey: e.props.hasSurvey,
        columns: fit.columns,
        layout: fit.layout,
        rows,
        surveys: surveyAsks,
      }
    }
    const fit = fitOf(layout, e.props.bodyColumns)
    if (e.props.hasSurvey) {
      surveyAsks += 1
      report(false, fit, 0)
      return next(e)
    }
    const [snap, count, hidden] = await Promise.all([read($, snapshot), countersOf($), read($, isHidden)])
    if (hidden || snap === null) {
      report(false, fit, 0)
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const palette = paletteOf(themeOption, snap.theme ?? 'dark', snap.appearance ?? null, e.surface)
    const widths = [fit.layout.col1, fit.layout.col2]
    const rows = rowsOf(gridOf(palette, snap, count, fit.layout), fit.columns)
    report(true, fit, rows.length)

    return (
      <Box flexDirection="column">
        {rows.map(row => (
          <Box flexDirection="row">
            {row.map((cell, i) => {
              const width = widths[i]
              // Overflowing content gets a single separating space instead of
              // gluing to the next column, as the script's pad_col does.
              const overflows = width !== undefined && widthOf(cell) >= width
              return (
                <Box flexShrink={0} {...(width === undefined ? {} : { minWidth: width })}>
                  <Text mono {...(palette.value === undefined ? {} : { color: palette.value })}>
                    {cell.map(span => (span.color === undefined ? span.text : <Text color={span.color}>{span.text}</Text>))}
                    {overflows ? ' ' : null}
                  </Text>
                </Box>
              )
            })}
          </Box>
        ))}
      </Box>
    )
  })
}
