import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib'
import {
  Effect,
  FederatedPrincipal,
  PolicyDocument,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam'
import { NagSuppressions } from 'cdk-nag'
import type { Construct } from 'constructs'
import type { StageName } from './stages'

const OIDC_HOST = 'token.actions.githubusercontent.com'
const DEFAULT_BRANCH: Record<StageName, string> = { dev: 'develop', stg: 'staging', prod: 'main' }

export interface GithubOidcStackProps extends StackProps {
  readonly stage: StageName
  readonly service: string
  readonly githubOrg: string
  readonly githubRepo: string
  /** Numeric owner id. `gh api repos/OWNER/REPO --jq .owner.id` */
  readonly githubOwnerId: number
  /** Numeric repo id. `gh api repos/OWNER/REPO --jq .id` */
  readonly githubRepoId: number
  /** Per-stage CDK bootstrap qualifier. Max 10 alphanumeric chars. */
  readonly bootstrapQualifier: string
  readonly oidcProviderArn: string
  readonly deployBranch?: string
}

/**
 * Per-stage GitHub Actions OIDC trust: a deploy role scoped to this stage's own
 * CDK bootstrap qualifier (never another stage's), plus — on `dev` only — a
 * read-only PR-diff role with explicit `Deny` on data-reading actions, since
 * `cdk diff` executes attacker-authored TypeScript from the pull request.
 */
export class GithubOidcStack extends Stack {
  public readonly deployRoleArn: string
  public readonly diffRoleArn?: string

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props)

    if (!/^[a-z0-9]{1,10}$/.test(props.bootstrapQualifier)) {
      throw new Error(
        `bootstrapQualifier must be 1-10 lowercase alphanumeric chars (got: ${props.bootstrapQualifier})`,
      )
    }

    const q = props.bootstrapQualifier
    const { account, region } = this
    // Immutable subject claim format — repos created after 2026-07-15 emit this (SEC-1).
    const repoRef = `${props.githubOrg}@${props.githubOwnerId}/${props.githubRepo}@${props.githubRepoId}`
    const workflowRepoRef = `${props.githubOrg}/${props.githubRepo}`
    const branch = props.deployBranch ?? DEFAULT_BRANCH[props.stage]

    const bootstrapRoles = [
      `arn:aws:iam::${account}:role/cdk-${q}-deploy-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-${q}-file-publishing-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-${q}-image-publishing-role-${account}-${region}`,
      `arn:aws:iam::${account}:role/cdk-${q}-lookup-role-${account}-${region}`,
    ]

    const deployRole = new Role(this, 'DeployRole', {
      roleName: `${props.service}-github-deploy-${props.stage}`,
      description: `GitHub OIDC deploy role for ${props.service} ${props.stage}.`,
      assumedBy: new FederatedPrincipal(
        props.oidcProviderArn,
        {
          StringEquals: { [`${OIDC_HOST}:aud`]: 'sts.amazonaws.com' },
          StringLike: {
            [`${OIDC_HOST}:sub`]: `repo:${repoRef}:environment:${props.stage}`,
          },
          // ForAnyValue fails CLOSED when the claim is absent.
          'ForAnyValue:StringEquals': {
            [`${OIDC_HOST}:job_workflow_ref`]: [
              `${workflowRepoRef}/.github/workflows/deploy.yml@refs/heads/${branch}`,
              `${workflowRepoRef}/.github/workflows/deploy-infra.yml@refs/heads/${branch}`,
            ],
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      inlinePolicies: {
        AssumeCdkBootstrap: new PolicyDocument({
          statements: [
            new PolicyStatement({ actions: ['sts:AssumeRole'], resources: bootstrapRoles }),
          ],
        }),
      },
    })
    this.deployRoleArn = deployRole.roleArn
    new CfnOutput(this, 'DeployRoleArn', { value: deployRole.roleArn })

    if (props.stage !== 'dev') return

    // PR diff role. cdk diff executes attacker-authored TypeScript from the PR, so
    // this role must never be able to read data — only CloudFormation metadata (SEC-2).
    // Scoped as far as a generic, reusable library can go: this account and region,
    // but not a specific stack name/id — the library has no way to know what a given
    // consumer will call their stacks. Shared with the NagSuppressions appliesTo
    // entry below so the two can never drift apart.
    const anyStackArn = `arn:aws:cloudformation:${region}:${account}:stack/*/*`

    const diffRole = new Role(this, 'DiffRole', {
      roleName: `${props.service}-github-cdk-diff`,
      description: 'Read-only GitHub OIDC role for cdk-diff.yml on pull requests.',
      assumedBy: new FederatedPrincipal(
        props.oidcProviderArn,
        {
          StringEquals: {
            [`${OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${OIDC_HOST}:sub`]: `repo:${repoRef}:pull_request`,
          },
          StringLike: {
            [`${OIDC_HOST}:job_workflow_ref`]: `${workflowRepoRef}/.github/workflows/cdk-diff.yml@refs/pull/*/merge`,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      inlinePolicies: {
        CfnMetadataOnly: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                'cloudformation:DescribeStacks',
                'cloudformation:GetTemplate',
                'cloudformation:DescribeStackResources',
              ],
              resources: [anyStackArn],
            }),
            // cloudformation:ListStacks has NO resource-level permissions — it is not
            // an ARN-addressable action in AWS's IAM action reference — so it cannot
            // be scoped below "*" (see the NagSuppressions justification below).
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ['cloudformation:ListStacks'],
              resources: ['*'],
            }),
            new PolicyStatement({
              effect: Effect.DENY,
              actions: [
                's3:GetObject',
                'lambda:GetFunction',
                'dynamodb:GetItem',
                'dynamodb:Scan',
                'dynamodb:Query',
                'secretsmanager:GetSecretValue',
                'ssm:GetParameter',
                'ssm:GetParameters',
                'kms:Decrypt',
              ],
              resources: ['*'],
            }),
          ],
        }),
      },
    })
    this.diffRoleArn = diffRole.roleArn
    new CfnOutput(this, 'DiffRoleArn', { value: diffRole.roleArn })

    // Three wildcards remain, each for a distinct, stateable reason. AwsSolutions-IAM5
    // flags ANY wildcard character in a resource string, not just a bare "*" — so the
    // `anyStackArn` scoping above earns its place (it narrows the grant from every
    // resource in every account/region down to CloudFormation stacks in THIS account
    // and region) without ever being able to silence the rule on its own, since a
    // reusable library cannot know a consumer's stack name(s) ahead of time.
    NagSuppressions.addResourceSuppressions(diffRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          "Three wildcards, none of which narrow further: (1) cloudformation:ListStacks has no resource-level permissions in AWS's IAM action reference — it is not ARN-addressable, so '*' is the only legal resource value. (2) The ALLOW on DescribeStacks/GetTemplate/DescribeStackResources is scoped to this account and region (arn:aws:cloudformation:<region>:<account>:stack/*/*) — the stack-name and unique-id segments stay wildcarded because this is a generic, reusable library with no way to know a consumer's stack name(s) at authoring time; this is already the narrowest possible grant. (3) The DENY statement's Resource::* is the security control, not a gap: cdk diff executes attacker-authored TypeScript from the pull request (SEC-2), so the data-reading actions must be blocked on every resource, and narrowing a Deny's scope would only widen what it fails to block.",
        appliesTo: ['Action::cloudformation:ListStacks', `Resource::${anyStackArn}`, 'Resource::*'],
      },
    ])
  }
}
