export type Run = {
  isOn: boolean
  round: number
  maxRounds: number
  // Rounds in a row that left GOALS.md unchanged.
  stuck: number
  lastGoals: string
  lastStop: string | null
}

export type GoalsSummary = {
  goal: string | null
  done: number
  total: number
  next: string | null
}

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
    }
  }
}
