import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import { CfnBudget } from 'aws-cdk-lib/aws-budgets'
import { OpenIdConnectProvider } from 'aws-cdk-lib/aws-iam'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions'
import type { Construct } from 'constructs'
import type { StageConfig, StageName } from './stages'

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com'
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com'

export interface PlatformStackProps extends StackProps {
  readonly stage: StageName
  readonly cfg: StageConfig
  readonly service: string
  readonly alertsEmail: string
  /**
   * True for the FIRST project bootstrapped into an AWS account; false for every
   * one after. The provider is account-level and CreateOpenIDConnectProvider fails
   * if one already exists. Detect with `aws iam list-open-id-connect-providers`.
   */
  readonly manageOidcProvider: boolean
}

export class PlatformStack extends Stack {
  public readonly alertsTopic: Topic
  public readonly oidcProviderArn: string

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props)

    this.alertsTopic = new Topic(this, 'AlertsTopic', {
      displayName: `${props.service} alerts (${props.stage})`,
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

    this.budget(`${props.service}-${props.stage}`, props.cfg.budgetUsd, props.alertsEmail, {
      TagKeyValue: [`user:Stage$${props.stage}`],
    })

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
