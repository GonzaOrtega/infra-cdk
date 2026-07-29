import type { App } from 'aws-cdk-lib'

export type StageName = 'dev' | 'stg' | 'prod'

export interface StageConfig {
  readonly logRetentionDays: 7 | 30 | 90
  readonly logLevel: 'debug' | 'info' | 'warn'
  readonly reservedConcurrency?: number
  readonly canary: boolean
  /** Monthly USD ceiling. No library default — a published default advertises the spend ceiling (SEC-4). */
  readonly budgetUsd: number
}

const STAGE_NAMES = ['dev', 'stg', 'prod'] as const

type StageDefaults = Omit<StageConfig, 'budgetUsd'>

const DEFAULTS: Record<StageName, StageDefaults> = {
  dev: { logRetentionDays: 7, logLevel: 'debug', canary: false },
  stg: { logRetentionDays: 30, logLevel: 'info', canary: false },
  prod: { logRetentionDays: 90, logLevel: 'info', canary: true, reservedConcurrency: 50 },
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
    result[stage] = { ...DEFAULTS[stage], ...overrides[stage], budgetUsd: budgets[stage] }
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
