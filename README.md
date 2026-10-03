# @gonza/infra-cdk

A reusable AWS CDK governance layer: cost-allocation tags, cdk-nag `AwsSolutionsChecks`,
a per-account monitoring/budget/OIDC platform stack, a per-stage GitHub Actions OIDC deploy
role, and a Lambda construct that cannot exist without an alarm wired to a real SNS topic.

This repo is **public** and contains no identifying literal in `src/` (no account id, no
ARN with a literal account id, no email, no real GitHub owner) — a test enforces this over
both the working tree and full git history on every change.

## Install

```bash
bun add --exact @gonza/infra-cdk@<version> aws-cdk-lib cdk-nag constructs
```

> **Pin an exact version, never a range or a dist-tag.** `^0.1.0` or `@latest` lets your next
> `bun install` pull code you never reviewed straight into a job holding deploy credentials
> (`cdk synth` executes this library's TypeScript). An exact npm version cannot be
> overwritten, and once unpublished its number cannot be reused; the lockfile also records
> the tarball's `sha512` integrity, so a changed tarball fails `bun install --frozen-lockfile`
> instead of installing. Run that in CI, and treat any lockfile diff touching this dependency
> as a review-gated change, same as a production secret.
>
> Installing from git (`github:GonzaOrtega/infra-cdk#<40-char-commit-sha>`) still works, but
> only pinned to the full commit SHA: a tag or branch ref is force-movable. Some sandboxed
> environments (cloud coding agents behind a GitHub proxy) cannot fetch git dependencies at
> all, which is why the npm package exists.

`aws-cdk-lib`, `cdk-nag`, and `constructs` are peer dependencies — install them alongside
this package at the versions your CDK app already uses (`^2.257.0`, `^2.38.0`, `^10.0.0`
respectively, or newer within those major lines).

> **No build step.** `package.json`'s `main`/`types` point straight at `src/index.ts` — this
> package ships raw TypeScript, not compiled JS + `.d.ts`. That's fine for `cdk synth`
> (which already runs your app through a TS-aware runner), but it means your bundler/runner
> must be able to resolve and compile `.ts` files from `node_modules` — `bunx cdk` and
> `ts-node`-based setups do this out of the box; a plain `node` invocation without a loader
> will not.

## Usage

`bin/app.ts` — the full wiring for a project's CDK app. This compiles against the current
API; check `src/*.ts` before copying if the API has moved on.

```ts
import { App, Stack } from 'aws-cdk-lib'
import {
  applyGovernance,
  defineStages,
  GithubOidcStack,
  MonitoredFn,
  PlatformStack,
  resolveStage,
} from '@gonza/infra-cdk'

const SERVICE = 'my-api'
const OWNER_EMAIL = 'you@example.com'

const app = new App()
const stage = resolveStage(app) // reads --context stage=dev|stg|prod, throws otherwise
const cfg = defineStages({ dev: 25, stg: 50, prod: 200 })[stage] // cfg.stage === stage — see below
const env = { account: process.env.CDK_DEFAULT_ACCOUNT!, region: 'us-east-1' }

applyGovernance(app, { service: SERVICE, owner: OWNER_EMAIL, stage })

// manageOidcProvider and accountBudgetUsd are both account-scoped, not stage-scoped:
// exactly ONE stage of ONE project per AWS account may own them (conventionally `dev`
// of the first project bootstrapped into the account). Gate on a SINGLE stage, not a
// per-project constant reused across dev/stg/prod — see "manageOidcProvider" below for
// why reusing one value across every stage's deploy fails the second deploy outright.
const platform = new PlatformStack(app, `${SERVICE}-platform-${stage}`, {
  env,
  cfg, // stage is derived from cfg.stage — do not pass a separate `stage` prop
  service: SERVICE,
  alertsEmail: OWNER_EMAIL,
  manageOidcProvider: stage === 'dev',
  accountBudgetUsd: stage === 'dev' ? 300 : undefined,
})

new GithubOidcStack(app, `${SERVICE}-oidc-${stage}`, {
  env,
  stage, // GithubOidcStack takes no `cfg`, so it keeps its own `stage` prop
  service: SERVICE,
  githubOrg: 'your-org',
  githubRepo: SERVICE,
  githubOwnerId: 12345678, // gh api repos/OWNER/REPO --jq '{repo: .id, owner: .owner.id}'
  githubRepoId: 87654321,
  bootstrapQualifier: `${stage}q`, // devq | stgq | prodq — must match this stage's `cdk bootstrap --qualifier`
  oidcProviderArn: platform.oidcProviderArn,
})

// Project-owned workload stack.
class ApiStack extends Stack {
  constructor(scope: App, id: string) {
    super(scope, id, { env })

    new MonitoredFn(this, 'Health', {
      entry: `${import.meta.dirname}/../src/handlers/health.ts`,
      cfg, // stage is derived from cfg.stage — do not pass a separate `stage` prop
      alertsTopic: platform.alertsTopic, // REQUIRED — an alarm with no action is silent
    })
  }
}

new ApiStack(app, `${SERVICE}-${stage}`)
```

`PlatformStack` and `MonitoredFn` both derive their stage from `cfg.stage` — set by
`defineStages` — instead of taking a separate `stage` prop. Threading `stage` and `cfg`
independently let them drift (`stage: 'prod'` paired with `cfg: stages.dev` used to silently
synthesize 7-day log retention under a prod `RETAIN` removal policy); deriving stage from
`cfg.stage` makes that impossible. `GithubOidcStack` does not take a `cfg`, so it keeps its
own `stage` prop.

## Bootstrap — one command per stage, each with its own qualifier

Every stage needs its own `cdk bootstrap` run with a **distinct `--qualifier`**:

```bash
bunx cdk bootstrap aws://<ACCOUNT>/<REGION> \
  --qualifier devq \
  --toolkit-stack-name CDKToolkit-dev \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/PowerUserAccess \
  --custom-permissions-boundary <boundary-name>

bunx cdk bootstrap aws://<ACCOUNT>/<REGION> \
  --qualifier stgq \
  --toolkit-stack-name CDKToolkit-stg \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/PowerUserAccess \
  --custom-permissions-boundary <boundary-name>

bunx cdk bootstrap aws://<ACCOUNT>/<REGION> \
  --qualifier prodq \
  --toolkit-stack-name CDKToolkit-prod \
  --cloudformation-execution-policies arn:aws:iam::aws:policy/PowerUserAccess \
  --custom-permissions-boundary <boundary-name>
```

**Do not reuse the default qualifier (`hnb659fds`) or share one qualifier across stages.**
A shared qualifier means every stage bootstraps into the *same* four roles
(`cdk-<qualifier>-deploy-role-...`, `-file-publishing-role-...`, `-image-publishing-role-...`,
`-lookup-role-...`), the same CloudFormation execution role, and the same asset bucket.
`GithubOidcStack`'s dev deploy role can only `sts:AssumeRole` into `devq`'s bootstrap roles
— but if dev and prod both bootstrapped with the same qualifier, "`devq`'s deploy role" and
"prod's deploy role" are the same role. The dev role could then update the prod stack, and
dev's file-publishing role could overwrite an asset in the shared bucket that prod deploys
unmodified — a supply-chain path from a lower-trust stage into production. Each
`GithubOidcStack` instance only lists its own stage's qualifier in its inline
`AssumeCdkBootstrap` policy; that isolation only holds if bootstrap itself used per-stage
qualifiers.

## `manageOidcProvider`

The GitHub Actions OIDC provider (`token.actions.githubusercontent.com`) is **account-level**
— there can only be one per AWS account, and `CreateOpenIDConnectProvider` fails if one
already exists. Set `manageOidcProvider: true` for **exactly ONE stage of ONE project per
AWS account** (it creates the provider with `RemovalPolicy.RETAIN`). Every other
`PlatformStack` instance in that account — every other stage of THIS project, and every
stage of every OTHER project — must pass `manageOidcProvider: false` (it imports the
provider by ARN instead).

That "one stage" qualifier matters as much as the "one project" qualifier:
`PlatformStack` is instantiated once per stage (`dev`, `stg`, `prod`), so reusing the same
`true` value across a single project's own stages is just as broken as reusing it across
different projects — `dev` deploys first and creates the provider, then `stg`'s deploy fails
with `EntityAlreadyExists`. Gate on a single stage, e.g. `manageOidcProvider: stage ===
'dev'`, never on a project-level constant applied to every stage's deploy.

Detect which case applies before writing `bin/app.ts`:

```bash
aws iam list-open-id-connect-providers
```

If the output already contains an ARN ending in `token.actions.githubusercontent.com`, the
provider exists — use `false` for every stage. If the list is empty (or has no entry for
that host), pick ONE stage of this project (conventionally `dev`) to own it.

## `accountBudgetUsd`

Define this for **exactly ONE stage of ONE project per AWS account** — the same single
`PlatformStack` instance that sets `manageOidcProvider: true`, never once per project and
never for more than one stage. The underlying budget is named `account-monthly`
(account-scoped, not stage-scoped); defining it a second time anywhere in the account —
including by reusing the same value across a project's own dev/stg/prod deploys — fails
that second deploy with `DuplicateRecordException`. Gate it on the same single stage as
`manageOidcProvider`, e.g. `accountBudgetUsd: stage === 'dev' ? 300 : undefined`.

The per-stage budget (`cfg.budgetUsd`, always set) filters on the `Stage` cost-allocation
tag via `CostFilters: { TagKeyValue: ['user:Stage$<stage>'] }`. That tag is **not active by
default** — activate it by hand in the AWS Console under **Billing → Cost allocation
tags**, and it takes roughly **24 hours** to start populating cost data. Until it's active,
every per-stage budget reads **zero** spend, not "unknown" — it looks healthy while
tracking nothing. Even once active, a tag-filtered budget **never sees untagged
resources at all** (a mistyped bin/app.ts that skips `applyGovernance`, a manually-created
resource, anything predating the tag). `accountBudgetUsd` — unfiltered, total account
spend — is therefore the only ceiling that is real from day one and stays real regardless
of tagging correctness. Treat the per-stage budgets as attribution, and the account budget
as the actual backstop.

## GitHub numeric ids

`GithubOidcStack` needs the GitHub org's and repo's **numeric** ids, not their names:

```bash
gh api repos/OWNER/REPO --jq '{repo: .id, owner: .owner.id}'
```

Feed `.repo` into `githubRepoId` and `.owner` into `githubOwnerId`.

This matters because **repositories created after 2026-07-15 emit an immutable `sub`
claim format** from GitHub's OIDC token issuer:

```
old (pre-2026-07-15 repos, name-based, mutable on rename): repo:octocat/my-repo:ref:refs/heads/main
new (repos created 2026-07-15 or later, id-based, immutable): repo:octocat@123456/my-repo@456789:ref:refs/heads/main
```

`GithubOidcStack` always emits the new, id-based format. If you hand it the wrong ids (or a
stack ported from older, name-based code), the trust policy's `StringLike` condition on
`sub` never matches what GitHub actually issues, and `AssumeRoleWithWebIdentity` fails —
silently, as a generic "not authorized to perform sts:AssumeRoleWithWebIdentity" error with
no indication the claim format is the cause.

## Cross-stack export unwind

`PlatformStack` exposes `alertsTopic` (an SNS `Topic`) as a `CfnOutput` / CloudFormation
export, so other stacks — `GithubOidcStack`, `MonitoredFn` inside a workload stack — can
reference `platform.alertsTopic` directly. CloudFormation refuses to delete or replace a
stack export while any other stack still imports it (`Export ... cannot be updated as it is
in use by ...`).

If you later stop referencing `platform.alertsTopic` from a workload stack — swapping to a
per-stack topic, decommissioning the workload stack, or restructuring which stack owns
alerting — removing the reference is **not a one-shot deploy**:

1. Deploy the workload stack first, with the reference to `platform.alertsTopic` removed
   (or the whole stack removed). This drops the `Fn::ImportValue` and releases the export.
2. Only then deploy `PlatformStack` with the change that affects the export (removing the
   topic, changing its logical id, deleting the stack).

Deploying both in one pass, or in the reverse order, fails the `PlatformStack` deploy with
an export-still-in-use error.

## Prod environment gate

`GithubOidcStack`'s deploy role trust policy scopes the prod role's `sub` condition to
`repo:<org>@<ownerId>/<repo>@<repoId>:environment:prod`. That string only requires the
triggering workflow run to declare `environment: prod` in its YAML — GitHub attaches that
claim whether or not anyone has to approve the run. **`environment:prod` in the trust
policy is not an approval control by itself.**

To make it one, configure the gate on the GitHub side: repo **Settings → Environments →
prod → Required reviewers** (and, ideally, restrict deployment branches to `main`). Without
required reviewers configured, anyone with write access to the repository can
`workflow_dispatch` a deploy with `stage=prod` and the IAM condition will happily let it
through — the environment name matched, nothing else was checked.

## Prod termination protection

`PlatformStack` sets CloudFormation `terminationProtection: true` automatically whenever
`cfg.stage === 'prod'` — a `cdk destroy` or an accidental stack deletion in the CloudFormation
console is rejected until protection is turned off by hand. `dev` and `stg` deploys are left
unprotected. This is derived from `cfg.stage`, so it follows automatically from passing the
right `cfg` — there is nothing to configure.

## Public API

```ts
export type StageName = 'dev' | 'stg' | 'prod'
export interface StageConfig {
  readonly stage: StageName // populated by defineStages — derive stage from cfg.stage, don't pass both
  readonly logRetentionDays: 7 | 30 | 90
  readonly logLevel: 'debug' | 'info' | 'warn'
  readonly reservedConcurrency?: number
  readonly budgetUsd: number
}

export function defineStages(
  budgets: Record<StageName, number>, // each value must be a positive finite number
  overrides?: Partial<Record<StageName, Partial<Omit<StageConfig, 'stage' | 'budgetUsd'>>>>,
): Record<StageName, StageConfig>

export function isStageName(value: unknown): value is StageName
export function resolveStage(app: App): StageName // throws if --context stage= is missing/invalid

export interface GovernanceOptions {
  readonly service: string
  readonly owner: string
  readonly stage: StageName
}
export function applyGovernance(app: App, opts: GovernanceOptions): void

export class PlatformStack extends Stack /* SNS alertsTopic + budget(s) + OIDC provider */
export class GithubOidcStack extends Stack /* per-stage deploy role + dev-only PR-diff role */
export class MonitoredFn extends Construct /* NodejsFunction + LogGroup + DLQ + alarms */
```

See `src/*.ts` for the full prop interfaces (`PlatformStackProps`, `GithubOidcStackProps`,
`MonitoredFnProps`) — every prop above that isn't self-explanatory is documented inline
where it's declared.
