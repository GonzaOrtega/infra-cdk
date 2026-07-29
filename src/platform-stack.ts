import { CfnOutput, RemovalPolicy, Stack, type StackProps, Tags } from 'aws-cdk-lib'
import { CfnBudget } from 'aws-cdk-lib/aws-budgets'
import { OpenIdConnectProvider } from 'aws-cdk-lib/aws-iam'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions'
import type { Construct } from 'constructs'
import type { StageConfig } from './stages'

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com'
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com'

export interface PlatformStackProps extends StackProps {
  readonly cfg: StageConfig
  readonly service: string
  readonly alertsEmail: string
  /**
   * True for exactly ONE stage of ONE project per AWS account — never once per
   * project (which would still leave every stage of that one project setting it
   * `true`) and never once per account outright. The OIDC provider is
   * account-level and `CreateOpenIDConnectProvider` fails if one already exists,
   * so reusing the same value across a project's dev/stg/prod deploys — not just
   * across different projects — creates it once and then fails with
   * EntityAlreadyExists on every other stage's deploy in that account.
   *
   * Pick the single stage of the single project that bootstraps this account
   * (conventionally `dev`) and set `true` there only; every other PlatformStack
   * instance in the account — every other stage of THIS project, and every stage
   * of every OTHER project — must pass `false`. Detect the starting state with
   * `aws iam list-open-id-connect-providers`.
   */
  readonly manageOidcProvider: boolean
  /**
   * Unfiltered account-wide monthly ceiling, in USD. Define this for exactly ONE
   * stage of ONE project per AWS account — the same single PlatformStack instance
   * that sets `manageOidcProvider: true`, never once per project and never for
   * more than one stage. The underlying budget is named `account-monthly`
   * (account-scoped, not stage-scoped); defining it a second time anywhere in the
   * account — including by reusing the same value across a project's own
   * dev/stg/prod deploys — fails that second deploy with
   * DuplicateRecordException.
   *
   * Required as a backstop: the per-stage budgets filter on the `Stage`
   * cost-allocation tag, which must be activated by hand in AWS Billing and takes
   * ~24h to populate. Until then a filtered budget reads ZERO, so without this a
   * fresh account has no cost ceiling at all.
   */
  readonly accountBudgetUsd?: number
}

/**
 * The account/project-wide platform primitives every stage's workload stacks
 * depend on: an SNS alerts topic (subscribed to `alertsEmail`), a stage-scoped
 * cost budget filtered on the `Stage` tag, and — for exactly one owning stage per
 * account — the GitHub Actions OIDC provider plus an unfiltered account-wide
 * budget backstop. See `manageOidcProvider` and `accountBudgetUsd` for the
 * single-owner rule that keeps this stack safe to instantiate once per stage.
 */
export class PlatformStack extends Stack {
  public readonly alertsTopic: Topic
  public readonly oidcProviderArn: string

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    const stage = props.cfg.stage
    super(scope, id, { ...props, terminationProtection: stage === 'prod' })

    // Guarantee this stack's own precondition: the stage budget below filters on
    // this tag, and a consumer who skips the optional `applyGovernance` call would
    // otherwise get a budget that silently reads $0 forever (SEC-4).
    Tags.of(this).add('Stage', stage)

    this.alertsTopic = new Topic(this, 'AlertsTopic', {
      displayName: `${props.service} alerts (${stage})`,
      enforceSSL: true,
    })
    this.alertsTopic.addSubscription(new EmailSubscription(props.alertsEmail))

    if (props.manageOidcProvider) {
      const provider = new OpenIdConnectProvider(this, 'GithubOidcProvider', {
        url: GITHUB_OIDC_URL,
        clientIds: ['sts.amazonaws.com'],
        // Deleting it would break every stage's deploy at once. NOTE: must be passed
        // here, not via provider.applyRemovalPolicy() afterwards — the provider's
        // node.defaultChild is the underlying CustomResource construct, not a
        // CfnResource, so a post-construction call throws CannotApplyRemovalPolicy.
        removalPolicy: RemovalPolicy.RETAIN,
      })
      this.oidcProviderArn = provider.openIdConnectProviderArn
    } else {
      this.oidcProviderArn = `arn:aws:iam::${this.account}:oidc-provider/${GITHUB_OIDC_HOST}`
    }

    this.budget(`${props.service}-${stage}`, props.cfg.budgetUsd, props.alertsEmail, {
      TagKeyValue: [`user:Stage$${stage}`],
    })

    // Unfiltered backstop. Deliberately has NO costFilters: it must keep working
    // while the Stage cost-allocation tag is still inactive, and it is the only
    // budget that sees untagged resources.
    if (props.accountBudgetUsd !== undefined) {
      this.budget('account', props.accountBudgetUsd, props.alertsEmail)
    }

    new CfnOutput(this, 'AlertsTopicArn', { value: this.alertsTopic.topicArn })
    new CfnOutput(this, 'OidcProviderArn', { value: this.oidcProviderArn })
  }

  private budget(
    name: string,
    amount: number,
    email: string,
    costFilters?: Record<string, string[]>,
  ): void {
    const notify = (
      type: 'ACTUAL' | 'FORECASTED',
      threshold: number,
    ): CfnBudget.NotificationWithSubscribersProperty => ({
      notification: {
        notificationType: type,
        comparisonOperator: 'GREATER_THAN',
        threshold,
        thresholdType: 'PERCENTAGE',
      },
      subscribers: [{ subscriptionType: 'EMAIL', address: email }],
    })

    new CfnBudget(this, `Budget${name.replace(/[^A-Za-z0-9]/g, '')}`, {
      budget: {
        budgetName: `${name}-monthly`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount, unit: 'USD' },
        costFilters,
      },
      notificationsWithSubscribers: [
        notify('ACTUAL', 80),
        notify('ACTUAL', 100),
        notify('FORECASTED', 100),
      ],
    })
  }
}
