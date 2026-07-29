import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib'
import {
  Effect,
  FederatedPrincipal,
  PolicyDocument,
  PolicyStatement,
  Role,
} from 'aws-cdk-lib/aws-iam'
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
                'cloudformation:ListStacks',
                'cloudformation:DescribeStackResources',
              ],
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
  }
}
