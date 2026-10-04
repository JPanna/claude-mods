// Commands the autopilot (or anyone) must not run unattended. Each pattern is
// checked per shell segment so `cd x && git push --force` is still caught.

const RULES: Array<[RegExp, string]> = [
  [/\bgit\s+push\b.*(\s--force\b|\s--force-with-lease\b|\s-[a-zA-Z]*f[a-zA-Z]*\b|\s\+\S)/, 'force-push rewrites shared history'],
  [/\bgit\s+push\b.*[\s:](main|master)(\s|$)/, 'pushing to main/master; push a feature branch instead'],
  [/\bgit\s+push\b.*(\s--delete\b|\s-d\b|\s:\S)/, 'deleting a remote branch'],
  [/\bgit\s+reset\s+.*--hard\b/, 'git reset --hard discards work; commit or `git stash` first'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean -f deletes untracked files'],
  [/\bgit\s+branch\s+-D\s+(main|master)\b/, 'deleting main/master'],
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]*\s+)*(--\s+)?("|')?(\/|~|\$HOME|\.\.?|\*)\/?\*?("|')?(\s|$)/, 'recursive delete of a root, home, parent or whole directory'],
  [/\b(DROP\s+(DATABASE|SCHEMA|TABLE)|TRUNCATE\s+TABLE)\b/i, 'dropping or truncating data'],
]

// Git's global options (`git -C repo -c k=v --no-pager push`) come before the
// subcommand; dropping them lets the rules see `git push`.
const GIT_GLOBALS = /\bgit((?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)(?:=\S+|\s+\S+)|--[a-z][a-z-]*(?:=\S+)?|-[a-zA-Z]))+)(?=\s)/g

function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\||\n/).map(s => s.replace(GIT_GLOBALS, 'git'))
}

export function dangerous(command: string): string | null {
  for (const segment of segments(command)) {
    for (const [pattern, reason] of RULES) {
      if (pattern.test(segment)) return reason
    }
    if (writesSecret(segment)) return 'writing a .env file holds secrets and is not done automatically'
  }
  return null
}

// Whether the command pushes at all; the hook then checks the current branch,
// since a bare `git push` on main names no branch.
export function pushes(command: string): boolean {
  return segments(command).some(s => /\bgit\s+push\b/.test(s))
}

const SECRET_FILE = /(^|\/)\.env(\.[^/]*)?$/
const SAFE_SECRET = /\.env\.(example|sample|template)$/

export function protectedFile(path: string): boolean {
  return SECRET_FILE.test(path) && !SAFE_SECRET.test(path)
}

// A shell segment that names a .env file and writes to it: a redirect, or a
// command that creates, changes or removes files. Reading one (`cat .env`) passes.
const WRITERS = /(>|\b(tee|cp|mv|rm|ln|install|truncate|dd|touch|chmod|chown)\b|\bsed\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*i|\bperl\s+.*-[a-zA-Z]*i)/

function writesSecret(segment: string): boolean {
  if (!WRITERS.test(segment)) return false
  const words = segment.split(/[\s'"=<>]+/).filter(Boolean)
  return words.some(word => protectedFile(word))
}

const TEST_COMMAND = /\b(pytest|py\.test|unittest|tox|nox|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+test|jest|vitest|mocha|go\s+test|cargo\s+test|mvn\s+test|gradle\w*\s+test|rspec|phpunit|dotnet\s+test)\b/

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command)
}
