import { App, type CfnResource } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { PlatformStack } from '../src/platform-stack'
import { defineStages } from '../src/stages'

const env = { account: '111111111111', region: 'us-east-1' }
const cfg = defineStages({ dev: 25, stg: 50, prod: 200 }).dev

function build(manageOidcProvider = true) {
  const app = new App()
  const stack = new PlatformStack(app, 'P', {
    env,
    cfg,
    service: 'example-svc',
    alertsEmail: 'alerts@example.com',
    manageOidcProvider,
  })
  return { stack, template: Template.fromStack(stack) }
}

describe('PlatformStack', () => {
  it('subscribes the alerts email to the topic', () => {
    build().template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'alerts@example.com',
    })
  })

  it('enforces SSL on the alerts topic', () => {
    // AwsSolutions-SNS3: without a TopicPolicy denying non-TLS publish, a
    // network-based attacker can eavesdrop on or tamper with alert traffic.
    build().template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    })
  })

  it('tags itself with Stage — the per-stage budget filter depends on it even if applyGovernance is skipped', () => {
    // SEC-4: the stage budget below filters on `user:Stage$dev`. A consumer who
    // skips the optional applyGovernance() call must still get a working filter.
    build().template.hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([{ Key: 'Stage', Value: 'dev' }]),
    })
  })

  it('scopes the stage budget to the Stage cost-allocation tag', () => {
    // Without CostFilters every stage budget measures TOTAL account spend, so dev's
    // $25 budget fires when prod spends $25 (SEC-4).
    build().template.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        BudgetLimit: { Amount: 25, Unit: 'USD' },
        CostFilters: { TagKeyValue: ['user:Stage$dev'] },
      }),
    })
  })

  it('notifies on FORECASTED as well as ACTUAL', () => {
    // Budgets lag 8-24h; ACTUAL-only means a compromised role mines for a day unseen.
    const budgets = build().template.findResources('AWS::Budgets::Budget')
    const all = JSON.stringify(budgets)
    expect(all).toContain('FORECASTED')
    expect(all).toContain('ACTUAL')
  })

  it('creates the OIDC provider with RETAIN when it owns it', () => {
    const t = build(true).template
    t.hasResource('Custom::AWSCDKOpenIdConnectProvider', { DeletionPolicy: 'Retain' })
  })

  it('imports the OIDC provider instead of creating it when told not to manage it', () => {
    // CreateOpenIDConnectProvider FAILS if one already exists in the account, so only
    // the first project bootstrapped into an account may manage it (SEC-14).
    const { stack, template } = build(false)
    expect(Object.keys(template.findResources('Custom::AWSCDKOpenIdConnectProvider'))).toHaveLength(
      0,
    )
    expect(stack.oidcProviderArn).toContain('oidc-provider/token.actions.githubusercontent.com')
  })

  it('adds an UNFILTERED account-wide budget when accountBudgetUsd is given', () => {
    const app = new App()
    const stack = new PlatformStack(app, 'P', {
      env,
      cfg,
      service: 'example-svc',
      alertsEmail: 'alerts@example.com',
      manageOidcProvider: true,
      accountBudgetUsd: 300,
    })
    const budgets = Object.values(Template.fromStack(stack).findResources('AWS::Budgets::Budget'))
    const unfiltered = budgets.filter((b) => b.Properties.Budget.CostFilters === undefined)
    expect(unfiltered).toHaveLength(1)
    expect(unfiltered[0]?.Properties.Budget.BudgetLimit).toEqual({ Amount: 300, Unit: 'USD' })
  })

  it('omits the account-wide budget when accountBudgetUsd is not given', () => {
    const budgets = Object.values(build().template.findResources('AWS::Budgets::Budget'))
    expect(budgets.every((b) => b.Properties.Budget.CostFilters !== undefined)).toBe(true)
  })

  it('synthesizes exactly ONE OIDC provider and ONE unfiltered account budget across two stages of the same project, when only one stage owns them', () => {
    // CRITICAL 2 regression guard: PlatformStack is instantiated once per stage, but
    // the OIDC provider and the account-wide budget are account-unique. Owning them
    // in more than one stage (e.g. reusing the same flag value across dev/stg/prod)
    // fails the second deploy with EntityAlreadyExists / DuplicateRecordException.
    const app = new App()
    const stages = defineStages({ dev: 25, stg: 50, prod: 200 })

    const owner = new PlatformStack(app, 'PlatformDev', {
      env,
      cfg: stages.dev,
      service: 'example-svc',
      alertsEmail: 'alerts@example.com',
      manageOidcProvider: true,
      accountBudgetUsd: 300,
    })
    const nonOwner = new PlatformStack(app, 'PlatformStg', {
      env,
      cfg: stages.stg,
      service: 'example-svc',
      alertsEmail: 'alerts@example.com',
      manageOidcProvider: false,
    })

    const templates = [Template.fromStack(owner), Template.fromStack(nonOwner)]

    const providerCount = templates
      .map((t) => Object.keys(t.findResources('Custom::AWSCDKOpenIdConnectProvider')).length)
      .reduce((a, b) => a + b, 0)
    expect(providerCount).toBe(1)

    const unfilteredBudgetCount = templates
      .map(
        (t) =>
          Object.values(t.findResources('AWS::Budgets::Budget')).filter(
            (b) => b.Properties.Budget.CostFilters === undefined,
          ).length,
      )
      .reduce((a, b) => a + b, 0)
    expect(unfilteredBudgetCount).toBe(1)
  })

  it('enables terminationProtection in prod, not in other stages', () => {
    const stages = defineStages({ dev: 25, stg: 50, prod: 200 })
    const app = new App()
    const prod = new PlatformStack(app, 'PProd', {
      env,
      cfg: stages.prod,
      service: 'example-svc',
      alertsEmail: 'alerts@example.com',
      manageOidcProvider: false,
    })
    const dev = new PlatformStack(app, 'PDev', {
      env,
      cfg: stages.dev,
      service: 'example-svc',
      alertsEmail: 'alerts@example.com',
      manageOidcProvider: false,
    })
    expect(prod.terminationProtection).toBe(true)
    expect(dev.terminationProtection).toBeFalsy()
  })

  it('pins the AlertsTopic construct id — renaming it replaces a production resource', () => {
    const { stack } = build()
    expect(stack.getLogicalId(stack.alertsTopic.node.defaultChild as CfnResource)).toMatch(
      /^AlertsTopic[0-9A-F]{8}$/,
    )
  })
})
