import type { App } from 'aws-cdk-lib'

export type StageName = 'dev' | 'stg' | 'prod'

export interface StageConfig {
  /**
   * The stage this config belongs to. Populated by `defineStages` — always derive
   * the stage from `cfg.stage` rather than threading a separate `stage` prop
   * alongside `cfg`; the two can otherwise drift (e.g. `stage: 'prod'` paired with
   * `cfg: stages.dev`), silently synthesizing the wrong retention/removal policy.
   */
  readonly stage: StageName
  readonly logRetentionDays: 7 | 30 | 90
  readonly logLevel: 'debug' | 'info' | 'warn'
  readonly reservedConcurrency?: number
  /** Monthly USD ceiling. No library default — a published default advertises the spend ceiling (SEC-4). */
  readonly budgetUsd: number
}

const STAGE_NAMES = ['dev', 'stg', 'prod'] as const

type StageDefaults = Omit<StageConfig, 'stage' | 'budgetUsd'>

const DEFAULTS: Record<StageName, StageDefaults> = {
  dev: { logRetentionDays: 7, logLevel: 'debug' },
  stg: { logRetentionDays: 30, logLevel: 'info' },
  prod: { logRetentionDays: 90, logLevel: 'info', reservedConcurrency: 50 },
}

export function isStageName(value: unknown): value is StageName {
  return typeof value === 'string' && (STAGE_NAMES as readonly string[]).includes(value)
}

export function defineStages(
  budgets: Record<StageName, number>,
  overrides: Partial<Record<StageName, Partial<StageDefaults>>> = {},
): Record<StageName, StageConfig> {
  const result = {} as Record<StageName, StageConfig>
  for (const stage of STAGE_NAMES) {
    const budgetUsd = budgets[stage]
    if (!(Number.isFinite(budgetUsd) && budgetUsd > 0)) {
      throw new Error(
        `defineStages: budgetUsd for stage "${stage}" must be a positive finite number (got: ${String(budgetUsd)})`,
      )
    }
    result[stage] = { ...DEFAULTS[stage], ...overrides[stage], stage, budgetUsd }
  }
  return result
}

export function resolveStage(app: App): StageName {
  const raw: unknown = app.node.tryGetContext('stage')
  if (!isStageName(raw)) {
    throw new Error(`cdk: pass --context stage=<${STAGE_NAMES.join('|')}> (got: ${String(raw)})`)
  }
  return raw
}
