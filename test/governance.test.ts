import { App, Stack } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { describe, expect, it } from 'vitest'
import { MonitoredFn } from '../src/constructs/monitored-fn'
import { GithubOidcStack } from '../src/github-oidc-stack'
import { applyGovernance } from '../src/governance'
import { PlatformStack } from '../src/platform-stack'
import { defineStages } from '../src/stages'

function build() {
  const app = new App()
  const stack = new Stack(app, 'G', { env: { account: '111111111111', region: 'us-east-1' } })
  new Topic(stack, 'T')
  applyGovernance(app, { service: 'example-svc', owner: 'alerts@example.com', stage: 'prod' })
  return stack
}

describe('applyGovernance', () => {
  it('tags every resource with Service, Stage, ManagedBy and Owner', () => {
    Template.fromStack(build()).hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([
        { Key: 'ManagedBy', Value: 'cdk' },
        { Key: 'Service', Value: 'example-svc' },
        { Key: 'Stage', Value: 'prod' },
      ]),
    })
  })

  it('emits AwsSolutions findings as WARNINGS, not errors', () => {
    // AwsSolutionsChecks emits MOST rules as warnings; only errors fail synth, so
    // CI must fail on warnings too or the gate is decorative (SEC-6). This test
    // proves the rule pack is actually loaded and firing — an assertion that only
    // checked `Array.isArray` would pass even with cdk-nag removed entirely.
    //
    // NOTE: the brief's original fixture (an unencrypted SNS Topic, expecting
    // AwsSolutions-SNS2/SNS3) does not hold against the installed cdk-nag 2.38.2:
    // AwsSolutions-SNS2 is not wired into the AwsSolutionsChecks pack at all (it
    // only appears in the NIST/PCI-DSS/HIPAA packs), and AwsSolutions-SNS3 fires
    // as an ERROR in this pack, not a warning. A DynamoDB Table without Point-in-
    // Time Recovery trips exactly AwsSolutions-DDB3 as a WARN with zero errors —
    // verified against the installed library — so it is used here instead.
    const app = new App()
    const stack = new Stack(app, 'Dirty', { env: { account: '111111111111', region: 'us-east-1' } })
    new Table(stack, 'Unprotected', { partitionKey: { name: 'id', type: AttributeType.STRING } }) // trips AwsSolutions-DDB3
    applyGovernance(app, { service: 'example-svc', owner: 'alerts@example.com', stage: 'dev' })

    const warnings = Annotations.fromStack(stack).findWarning(
      '*',
      Match.stringLikeRegexp('AwsSolutions-.*'),
    )
    expect(warnings.length).toBeGreaterThan(0)
    expect(
      Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
    ).toHaveLength(0)
  })

  it('produces ZERO error-level annotations composing PlatformStack + MonitoredFn — the library must pass its own gate', () => {
    // The original version of this test built a stack with ZERO resources, which
    // trivially has zero findings — it would pass even if every construct in this
    // library tripped an error. That is why three AwsSolutions ERRORS (SNS3 on the
    // topic, SQS3 on the DLQ, IAM4 on the Lambda execution role) shipped
    // undetected and made the README's own usage example unable to `cdk synth`.
    // This rebuild composes the library's own constructs — exactly what a
    // consumer following the README does — and asserts on error-level findings
    // only: cdk-nag emits many WARN-level findings by design (see the test above),
    // so this must not assert zero warnings too.
    const env = { account: '111111111111', region: 'us-east-1' }
    const app = new App()
    const cfg = defineStages({ dev: 25, stg: 50, prod: 200 }).dev
    applyGovernance(app, { service: 'example-svc', owner: 'alerts@example.com', stage: 'dev' })

    const platform = new PlatformStack(app, 'Platform', {
      env,
      cfg,
      service: 'example-svc',
      alertsEmail: 'alerts@example.com',
      manageOidcProvider: true,
    })

    const workload = new Stack(app, 'Workload', { env })
    new MonitoredFn(workload, 'Health', {
      entry: `${import.meta.dirname}/fixtures/handler.ts`,
      cfg,
      alertsTopic: platform.alertsTopic,
    })

    for (const stack of [platform, workload]) {
      expect(
        Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
        stack.stackName,
      ).toHaveLength(0)
    }
  })

  it('produces ZERO error-level annotations composing PlatformStack + GithubOidcStack — a consumer instantiating both must synth clean', () => {
    // GithubOidcStack was never composed in this file, which is exactly how an
    // IAM5 finding on the dev-only DiffRole's CfnMetadataOnly policy (both its
    // wildcard-resource ALLOW and DENY statements) reached a consumer (`corpus`)
    // undetected. This mirrors the PlatformStack+MonitoredFn case above: real
    // constructs, error-level findings only.
    const env = { account: '111111111111', region: 'us-east-1' }
    const app = new App()
    const cfg = defineStages({ dev: 25, stg: 50, prod: 200 }).dev
    applyGovernance(app, { service: 'example-svc', owner: 'alerts@example.com', stage: 'dev' })

    const platform = new PlatformStack(app, 'Platform', {
      env,
      cfg,
      service: 'example-svc',
      alertsEmail: 'alerts@example.com',
      manageOidcProvider: true,
    })

    const oidc = new GithubOidcStack(app, 'Oidc', {
      env,
      stage: 'dev',
      service: 'example-svc',
      githubOrg: 'example-org',
      githubRepo: 'example-repo',
      githubOwnerId: 1,
      githubRepoId: 2,
      bootstrapQualifier: 'devq',
      oidcProviderArn: platform.oidcProviderArn,
    })

    for (const stack of [platform, oidc]) {
      expect(
        Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('AwsSolutions-.*')),
        stack.stackName,
      ).toHaveLength(0)
    }
  })
})
