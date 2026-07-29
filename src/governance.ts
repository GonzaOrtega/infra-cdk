import { type App, Aspects, Tags } from 'aws-cdk-lib'
import { AwsSolutionsChecks } from 'cdk-nag'
import type { StageName } from './stages'

export interface GovernanceOptions {
  readonly service: string
  readonly owner: string
  readonly stage: StageName
}

/**
 * Installs the cross-cutting policy layer on an entire CDK app: cost-allocation
 * tags plus cdk-nag's AwsSolutions rule pack.
 *
 * NOTE: cdk-nag emits most findings as WARNINGS, not errors — only errors fail
 * `cdk synth`. CI must therefore fail on warnings too (SEC-6), and a suppression
 * is a one-line bypass, so `stack-audit` gates suppressions separately.
 *
 * NOTE: this runs only if called. A second App, a new bin entry, or a raw
 * `new NodejsFunction()` bypasses it entirely — the durable control is the
 * CloudFormation execution role's permissions boundary (SEC-9).
 */
export function applyGovernance(app: App, opts: GovernanceOptions): void {
  Tags.of(app).add('Service', opts.service)
  Tags.of(app).add('Stage', opts.stage)
  Tags.of(app).add('ManagedBy', 'cdk')
  Tags.of(app).add('Owner', opts.owner)

  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
}
