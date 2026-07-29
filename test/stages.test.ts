import { App } from 'aws-cdk-lib'
import { describe, expect, it } from 'vitest'
import { defineStages, resolveStage } from '../src/stages'

const BUDGETS = { dev: 25, stg: 50, prod: 200 } as const

describe('defineStages', () => {
  it('applies per-stage defaults', () => {
    const s = defineStages(BUDGETS)
    expect(s.dev.logRetentionDays).toBe(7)
    expect(s.dev.logLevel).toBe('debug')
    expect(s.prod.logRetentionDays).toBe(90)
    expect(s.prod.reservedConcurrency).toBe(50)
  })

  it('requires budgets from the caller — the library ships no default amount', () => {
    expect(defineStages(BUDGETS).prod.budgetUsd).toBe(200)
  })

  it('lets a caller override a non-budget field', () => {
    const s = defineStages(BUDGETS, { dev: { logLevel: 'warn' } })
    expect(s.dev.logLevel).toBe('warn')
    expect(s.dev.logRetentionDays).toBe(7)
  })

  it('populates cfg.stage so consumers can derive the stage from cfg instead of threading it separately', () => {
    const s = defineStages(BUDGETS)
    expect(s.dev.stage).toBe('dev')
    expect(s.stg.stage).toBe('stg')
    expect(s.prod.stage).toBe('prod')
  })

  it('rejects a zero or negative budget, matching how GithubOidcStack validates its qualifier', () => {
    expect(() => defineStages({ ...BUDGETS, dev: 0 })).toThrow(/budgetUsd/i)
    expect(() => defineStages({ ...BUDGETS, dev: -10 })).toThrow(/budgetUsd/i)
    expect(() => defineStages({ ...BUDGETS, dev: Number.NaN })).toThrow(/budgetUsd/i)
    expect(() => defineStages({ ...BUDGETS, dev: Number.POSITIVE_INFINITY })).toThrow(/budgetUsd/i)
  })
})

describe('resolveStage', () => {
  it('reads a valid stage from cdk context', () => {
    const app = new App({ context: { stage: 'stg' } })
    expect(resolveStage(app)).toBe('stg')
  })

  it('throws on an unknown stage, naming the valid ones', () => {
    const app = new App({ context: { stage: 'prd' } })
    expect(() => resolveStage(app)).toThrow(/dev\|stg\|prod/)
  })

  it('throws when stage is absent', () => {
    expect(() => resolveStage(new App())).toThrow(/--context stage=/)
  })
})
