export type Run = {
  isOn: boolean
  round: number
  maxRounds: number
  // Rounds in a row that left GOALS.md unchanged.
  stuck: number
  lastGoals: string
  lastStop: string | null
  // 'checks' while a /autopilot checks turn writes the tests; 'work' otherwise.
  phase: 'work' | 'checks'
  // The task being worked, the commit it started from (for reverting), and
  // how many rounds in a row it failed the check.
  task: string | null
  base: string | null
  fails: number
  // The commit /autopilot checks started from; /autopilot lock locks what changed since.
  checksBase: string | null
  // Each round is delegated to a fresh subagent (/autopilot fresh on).
  fresh: boolean
  verdict: Verdict | null
}

export type Verdict = { passed: boolean; at: number; command: string }

export type GoalsSummary = {
  goal: string | null
  done: number
  total: number
  next: string | null
}

// The session task checklist autopilot mirrors GOALS.md into: item key -> task.
export type MirroredTask = { id: string; subject: string; status: string }
export type TaskMirror = Record<string, MirroredTask>

export type TestRun = { passed: boolean; at: number; command: string }

export type Stats = {
  turnSeconds: number | null
  turnTools: number
  files: string[]
  lastTest: TestRun | null
}

declare module 'claude-code' {
  interface PluginState {
    autopilot: {
      run: Run
      goals: GoalsSummary | null
      stats: Stats
      isHidden: boolean
      tasks: TaskMirror
    }
  }
}
