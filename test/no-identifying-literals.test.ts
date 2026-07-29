import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')

// The account-id slot of an ARN (`arn:aws:<service>:<region>:<account-id>:<resource>`)
// is where the repo legitimately composes ARNs from `this.account` via template
// literals (see platform-stack.ts, github-oidc-stack.ts). After ${...} stripping,
// that slot reads "X", not digits — so this only fires on a LITERAL 12-digit
// account id baked directly into an ARN string, never on a composed one.
const FORBIDDEN: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'AWS account id', re: /(?<!\d)\d{12}(?!\d)/ },
  {
    name: 'ARN with hardcoded account id',
    re: /arn:aws[a-z-]*:[^:\n]*:[^:\n]*:(?<!\d)\d{12}(?!\d)/,
  },
  { name: 'email address', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/ },
  { name: 'real GitHub owner', re: /GonzaOrtega/i },
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith('.ts') ? [full] : []
  })
}

function findHits(text: string): string[] {
  // Strip ONLY interpolations whose body is a bare identifier or property path
  // (${this.account}, ${props.githubOrg}) — those are legitimate compositions.
  // An interpolation containing a quoted literal or any other expression, e.g.
  // ${'820815709766'}, is deliberately NOT stripped: an unconditional strip blinds
  // the guard to any value hidden inside a slot.
  const identifierStripped = text.replace(
    /\$\{\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}/g,
    'X',
  )
  // Unwrap (don't blank) interpolations whose body is a single quoted string
  // literal, e.g. ${'820815709766'} -> 820815709766. The FORBIDDEN patterns below
  // are character-class based (`[\w.+-]+@[\w-]+`, `\d{12}`, ...), so `${`, `}` and
  // quote characters sitting between two split fragments — e.g.
  // `${'someone'}@${'example.com'}` — would otherwise break adjacency and hide
  // the literal from the very patterns meant to catch it, even though it was
  // never stripped. Unwrapping keeps the literal's characters contiguous with
  // whatever literal text surrounds it, so it stays visible to those patterns.
  const stripped = identifierStripped.replace(/\$\{\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*\}/g, '$2')
  return FORBIDDEN.filter(({ re }) => re.test(stripped)).map(({ name }) => name)
}

describe('no identifying literals', () => {
  it('src/ is free of account ids, ARNs, emails and real org names', () => {
    const hits: string[] = []
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8')
      for (const name of findHits(text)) hits.push(`${file}: ${name}`)
    }
    expect(hits).toEqual([])
  })

  it('git history is free of the same identifying literals', () => {
    // History is permanent — GitHub serves dangling commits by SHA even after a
    // force-push, so a single bad commit burns the value and it must be rotated,
    // not amended away (SEC-10). execFileSync (no shell, argv array) rather than
    // execSync/a shell string, and deliberately no `|| true`: if the git command
    // itself fails, the test must fail loudly, not silently report zero hits — a
    // swallowed error would be a guard that always passes.
    const diff = execFileSync('git', ['log', '-p', '--all', '--', 'src/'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    const hits: string[] = []
    for (const line of added) {
      for (const name of findHits(line)) hits.push(`${name}: ${line}`)
    }
    expect(hits).toEqual([])
  })
})
