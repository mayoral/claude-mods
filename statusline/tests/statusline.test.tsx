import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage } from 'claude-code'

// Wed 2026-10-22 12:00 UTC, the moment every test's clock starts at.
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const ROOT = '/Users/me/work/app'

const BAND = {
  plugin: 'statusline',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 160,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const usageOf = (): SessionUsage => ({
  startedAt: NOW - 90 * MINUTE,
  context: { tokens: 123_456, window: 1_000_000, percent: 42 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 63.5, resetsAt: new Date(NOW + 2 * HOUR + 15 * MINUTE).toISOString() },
    { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(NOW + 2 * DAY + 3 * HOUR).toISOString() },
  ],
  cost: { usd: 3.456 },
})

// What `git rev-parse` and `git status --porcelain=v2 --branch` print in the
// main working tree of a repository, on main, two ahead, one behind, dirty.
const SHAPE = `${ROOT}/.git\n${ROOT}/.git\n${ROOT}\n`
const STATUS = [
  '# branch.oid abcdef1234567890',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 .M N... 100644 100644 100644 abc123 abc123 src/a.ts',
  '',
].join('\n')

type World = {
  usage: SessionUsage
  files: Record<string, string>
  gitShape: string
  gitStatus: string
  /** What git exits with; 128 outside a repository. */
  gitExitCode?: number
  /** The Theme setting as /config lists it; dark when not given. */
  theme?: string
  /** What macOS answers for its appearance; not given, the command is not there. */
  appearance?: 'light' | 'dark'
  /** The surfaces attached; the desktop alone when not given. */
  surfaces?: readonly ('terminal' | 'desktop')[]
  store?: Record<string, unknown>
}

// Nothing sits beneath the plugin: these hooks stand for the engine. A call on
// `$` is answered `{ value }`; an event by its own result.
const engine = (on: On, world: World) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__statusline__${e.name}` } }))
  on('session.version', () => ({ value: { version: '2.1.308', base: '2.1.308', builtAt: '2026-10-01T00:00:00Z' } }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.usage', () => ({ value: world.usage }))
  on('session.surfaces', () => ({ value: world.surfaces ?? ['desktop'] }))
  on('config.list', () => ({
    value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: world.theme ?? 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }],
  }))
  on('process.run', (_, e) => {
    const answer = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'defaults') {
      // macOS: the key is there in dark mode only; elsewhere the command is not.
      if (world.appearance === undefined) return { deny: 'defaults: command not found' }
      return world.appearance === 'dark' ? answer(0, 'Dark\n') : answer(1, '')
    }
    return answer(world.gitExitCode ?? 0, e.argv.includes('status') ? world.gitStatus : world.gitShape)
  })
  on('fs.exists', (_, e) => ({ value: e.path in world.files }))
  on('fs.read', (_, e) => ({ value: world.files[e.path] ?? '' }))
  on('tool.call', (_, e) => {
    // The engine's own edit tools, as far as the files go.
    if (e.tool === 'Edit') world.files[e.file_path] = (world.files[e.file_path] ?? '').replace(e.old_string, e.new_string)
    if (e.tool === 'Write') world.files[e.file_path] = e.content
    return { result: {} }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  mock.env(on, { HOME: '/Users/me' })
  mock.store(on, world.store ?? {})
}

type Drawing = {
  find: (q: { type: string; text: RegExp }) => Promise<{ text: string; props: Record<string, unknown> } | undefined>
  findAll: (q: { type: string; text: RegExp }) => Promise<{ text: string; props: Record<string, unknown> }[]>
}

const textOf = async (ui: Drawing, text: RegExp) => (await ui.find({ type: 'Text', text }))?.text

/** The color of the innermost Text showing `text`: a cell's own span, not the cell around it. */
const colorOf = async (ui: Drawing, text: RegExp) => (await ui.findAll({ type: 'Text', text })).at(-1)?.props.color

/** The first bar's width: its fill and its track, drawn as two spans. */
const barWidthOf = async (ui: Drawing) => {
  const fill = await ui.find({ type: 'Text', text: /^━+$/ })
  const track = await ui.find({ type: 'Text', text: /^─+$/ })
  return Array.from(fill?.text ?? '').length + Array.from(track?.text ?? '').length
}

test('the band draws the four rows of the script, on the terminal and the desktop', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })

    // Row 1: context bar, model, 5h window with its countdown (63.5 rounds to 64).
    expect(await textOf(ui, /Context: /)).toContain(' 42%')
    expect(await barWidthOf(ui)).toBe(25)
    expect(await textOf(ui, /^Fable 5\.1$/)).toBe('Fable 5.1')
    expect(await textOf(ui, /5h: /)).toContain('64% (2h 15m)')
    // Row 2: project under ~, version, 7d window.
    expect(await textOf(ui, /^~\/work\/app$/)).toBe('~/work/app')
    expect(await textOf(ui, /^2\.1\.308$/)).toBe('2.1.308')
    expect(await textOf(ui, /7d: /)).toContain('12% (2d 3h)')
    // Row 3: lines, no worktree, branch with dirty marker and arrows.
    expect(await textOf(ui, /^\+0$/)).toBe('+0')
    expect(await textOf(ui, /^-0$/)).toBe('-0')
    expect(await ui.find({ type: 'Text', text: /wt: / })).toBeUndefined()
    expect(await textOf(ui, /^main$/)).toBe('main')
    expect(await textOf(ui, /^\*$/)).toBe('*')
    expect(await textOf(ui, /^↑2 ↓1$/)).toBe('↑2 ↓1')
    // Row 4: session duration, tokens, cost.
    expect(await textOf(ui, /session: /)).toContain('1h 30m')
    expect(await textOf(ui, /in: /)).toContain('123.4k')
    expect(await textOf(ui, /^cost: \$3\.46$/)).toBe('cost: $3.46')
    // The band answered for itself: nothing of the engine's is drawn.
    expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeUndefined()

    await ui.unmount()
  }
})

test('a linked worktree and a detached HEAD are named as the script names them', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, {
    usage: usageOf(),
    files: {},
    gitShape: `${ROOT}/.git/worktrees/feature\n${ROOT}/.git\n/Users/me/work/app-feature\n`,
    gitStatus: '# branch.oid abcdef1234567890\n# branch.head (detached)\n',
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textOf(ui, /^app-feature$/)).toBe('app-feature')
  expect(await textOf(ui, /^@abcdef1$/)).toBe('@abcdef1')
  expect(await ui.find({ type: 'Text', text: /^\*$/ })).toBeUndefined()
  await ui.unmount()
})

test('the edit tools add up the lines they change, and a turn its output tokens', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world: World = { usage: usageOf(), files: { [`${ROOT}/a.ts`]: 'one\ntwo\nthree\n' }, gitShape: SHAPE, gitStatus: STATUS }
  engine(on, world)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()

  // The engine's tool.call, typed loosely: its input type is too deep to check
  // once a large MCP tool table is laid beside the mod.
  const callTool = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<unknown>
  // Two lines in, one replaced: +3 -1. Then a new file of two lines: +2.
  await callTool({ tool: 'Edit', file_path: `${ROOT}/a.ts`, old_string: 'two', new_string: 'dos\n2b\n2c' })
  await callTool({ tool: 'Write', file_path: `${ROOT}/b.ts`, content: 'x\ny\n' })
  await $.turn.complete({
    answer: 'done',
    durationMs: 1200,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { model: 'claude-fable-5-1', input_tokens: 10, output_tokens: 2_500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  // The git cells are read again once the tool calls have settled.
  await clock.advance(600)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(ui, /^\+5$/)).toBe('+5')
  expect(await textOf(ui, /^-1$/)).toBe('-1')
  expect(await textOf(ui, /out: /)).toContain('out: 2.5k')
  await ui.unmount()
})

test('a measurement redraws the figures, and the minute tick moves the clocks', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world: World = { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS }
  engine(on, world)

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()

  world.usage = { ...usageOf(), context: { tokens: 850_000, window: 1_000_000, percent: 85 } }
  await $.session.measure({ context: world.usage.context, rateLimits: world.usage.rateLimits, cost: world.usage.cost, changed: ['context'] })
  await clock.advance(600)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textOf(ui, /Context: /)).toContain(' 85%')
  await ui.unmount()

  // Ten minutes on: the session is 1h 40m old and the 5h reset ten minutes nearer.
  await clock.advance(10 * MINUTE)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await textOf(ui, /session: /)).toContain('1h 40m')
  expect(await textOf(ui, /5h: /)).toContain('(2h 5m)')
  await ui.unmount()
})

test('a narrower band keeps the three columns with shorter bars; a very narrow one reflows', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()

  // 100 cells: the grid needs 118, so columns and bars shrink together
  // (40/40/25/20 become 33/33/18/16) and the three columns stay.
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 100 }, surface: 'desktop' })
  expect(await barWidthOf(ui)).toBe(18)
  expect(await textOf(ui, /^Fable 5\.1$/)).toBe('Fable 5.1')

  // The inspect tool reports that drawing.
  const callTool = $.tool.call as unknown as (input: Record<string, unknown>) => Promise<{ result?: unknown }>
  const { result } = await callTool({ tool: 'mcp__statusline__inspect' })
  const report = JSON.parse(String(result)) as { lastRender: { surface: string; bodyColumns: number; columns: number; layout: { ctxBar: number; rateBar: number } } }
  expect(report.lastRender.surface).toBe('desktop')
  expect(report.lastRender.bodyColumns).toBe(100)
  expect(report.lastRender.columns).toBe(3)
  expect(report.lastRender.layout).toEqual({ col1: 33, col2: 33, ctxBar: 18, rateBar: 16 })
  await ui.unmount()

  // 60 cells: one column, every cell still drawn.
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 }, surface: 'terminal' })
  expect(await textOf(narrow, /^Fable 5\.1$/)).toBe('Fable 5.1')
  expect(await textOf(narrow, /^cost: \$3\.46$/)).toBe('cost: $3.46')
  await narrow.unmount()
})

test('the palette follows the Theme setting: Mocha on dark, Latte on light', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world: World = { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS, theme: 'dark' }
  engine(on, world)

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()

  let ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await colorOf(ui, /^Fable 5\.1$/)).toBe('#74c7ec')
  expect(await colorOf(ui, /^main$/)).toBe('#94e2d5')
  expect(await colorOf(ui, /^cost: /)).toBe('#f9e2af')
  // The bar's track is drawn in its own color, apart from the fill.
  expect(await colorOf(ui, /^─+$/)).toBe('#585b70')
  await ui.unmount()

  // The person switches to a light theme: the next reading brings Latte.
  world.theme = 'light'
  await $.session.measure({ context: world.usage.context, rateLimits: world.usage.rateLimits, cost: world.usage.cost, changed: ['cost'] })
  await clock.advance(600)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await colorOf(ui, /^Fable 5\.1$/)).toBe('#209fb5')
  expect(await colorOf(ui, /^~\/work\/app$/)).toBe('#1e66f5')
  await ui.unmount()
})

test('on the desktop the palette follows the app\'s appearance, not the Theme setting', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const world: World = { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS, theme: 'dark', appearance: 'light' }
  engine(on, world)

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()

  // The app follows a light machine, the Theme setting is dark: Latte on the
  // desktop, Mocha on the terminal.
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await colorOf(desktop, /^Fable 5\.1$/)).toBe('#209fb5')
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await colorOf(terminal, /^Fable 5\.1$/)).toBe('#74c7ec')
  await terminal.unmount()

  // The app's own Appearance setting is set to dark, the machine still light:
  // the next reading brings Mocha to the desktop.
  const appConfig = '/Users/me/Library/Application Support/Claude/config.json'
  world.files[appConfig] = JSON.stringify({ userThemeMode: 'dark' })
  await clock.advance(60_000)
  const dark = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await colorOf(dark, /^Fable 5\.1$/)).toBe('#74c7ec')
  await dark.unmount()

  // Set back to follow the system: the light machine brings Latte again.
  world.files[appConfig] = JSON.stringify({ userThemeMode: 'system' })
  await clock.advance(60_000)
  const system = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await colorOf(system, /^Fable 5\.1$/)).toBe('#209fb5')
  await system.unmount()
})

test('the default theme keeps the script\'s colors', { options: { theme: 'default' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await colorOf(ui, /^Fable 5\.1$/)).toBe('cyan')
  // One bar, fill and track in the one color, as the script draws it.
  expect(await colorOf(ui, /^━+$/)).toBe('success')
  expect(await colorOf(ui, /^─+$/)).toBe('success')
  await ui.unmount()
})

test('a one-line summary is pinned under the prompt, and cleared when the band is hidden', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS })
  const pinned: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    pinned.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(pinned.at(-1)).toBe('Context 42% · 5h 64% (2h 15m) · 7d 12% (2d 3h) · main* ↑2 ↓1 · +0 -0 · $3.46')

  await $.command.run({ command: 'statusband', args: 'off', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(pinned.at(-1)).toBeUndefined()
  await $.command.run({ command: 'statusband', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(pinned.at(-1)).toContain('Context 42%')
})

test('in a terminal alone the line is not pinned, unless asked for always', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS, surfaces: ['terminal'] })
  const pinned: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    pinned.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(pinned.every(text => text === undefined)).toBe(true)
})

test('with the status line set to always, a terminal alone gets it too', { options: { statusLine: 'always' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS, surfaces: ['terminal'] })
  const pinned: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    pinned.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(pinned.at(-1)).toContain('Context 42%')
})

test('with the status line off, nothing is pinned', { options: { statusLine: 'off' } }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS })
  const pinned: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    pinned.push(e.text)
    return { value: undefined }
  })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()
  expect(pinned.every(text => text === undefined)).toBe(true)
})

test('the demo fills every cell with made-up figures, and live brings the real ones back', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS })
  const run = (args: string) =>
    $.command.run({ command: 'statusband', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()

  await run('demo')
  const demo = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(demo, /^claude-mods-login$/)).toBe('claude-mods-login')
  expect(await textOf(demo, /^feature\/login$/)).toBe('feature/login')
  expect(await textOf(demo, /^↑2 ↓1$/)).toBe('↑2 ↓1')
  expect(await textOf(demo, /^\+128$/)).toBe('+128')
  expect(await textOf(demo, /5h: /)).toContain('81% (2h 15m)')
  expect(await textOf(demo, /in: /)).toContain('in: 1.2M out: 45.6k')
  expect(await textOf(demo, /^cost: \$12\.34$/)).toBe('cost: $12.34')
  // The version stays the real one: the demo fakes only the figures.
  expect(await textOf(demo, /^2\.1\.308$/)).toBe('2.1.308')
  await demo.unmount()

  await run('live')
  const live = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(live, /^main$/)).toBe('main')
  expect(await ui_find_none(live)).toBe(true)
  await live.unmount()
})

const ui_find_none = async (ui: Drawing) => (await ui.find({ type: 'Text', text: /claude-mods-login/ })) === undefined

test('hidden in the store, the band leaves the drawing to the engine', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: SHAPE, gitStatus: STATUS, store: { isHidden: true } })

  await $.session.start({ cwd: ROOT, surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await textOf(ui, /^engine$/)).toBe('engine')
  expect(await ui.find({ type: 'Text', text: /Model/ })).toBeUndefined()
  await ui.unmount()
})

test('outside a repository the git cells are left out', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  engine(on, { usage: usageOf(), files: {}, gitShape: '', gitStatus: '', gitExitCode: 128 })

  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /branch: / })).toBeUndefined()
  expect(await textOf(ui, /^Fable 5\.1$/)).toBe('Fable 5.1')
  await ui.unmount()
})
