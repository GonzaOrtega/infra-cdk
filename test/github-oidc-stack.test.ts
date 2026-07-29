import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { GithubOidcStack } from '../src/github-oidc-stack'

const env = { account: '111111111111', region: 'us-east-1' }
const base = {
  env,
  service: 'example-svc',
  githubOrg: 'example-org',
  githubRepo: 'example-repo',
  githubOwnerId: 1,
  githubRepoId: 2,
  oidcProviderArn: 'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com',
}

const build = (stage: 'dev' | 'stg' | 'prod', qualifier: string) =>
  Template.fromStack(
    new GithubOidcStack(new App(), 'O', { ...base, stage, bootstrapQualifier: qualifier }),
  )

describe('GithubOidcStack', () => {
  it('uses the IMMUTABLE sub claim format', () => {
    // Repos created after 2026-07-15 emit repo:OWNER@ID/REPO@ID:... The old format
    // silently fails AssumeRoleWithWebIdentity on every new repo (SEC-1).
    build('prod', 'prodq').hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              StringLike: Match.objectLike({
                'token.actions.githubusercontent.com:sub':
                  'repo:example-org@1/example-repo@2:environment:prod',
              }),
            }),
          }),
        ]),
      }),
    })
  })

  it('pins job_workflow_ref under ForAnyValue:StringEquals — a plain StringEquals fails open on repeated claims', () => {
    // ForAnyValue:StringEquals fails CLOSED when the claim is absent from the token;
    // a plain StringEquals against a multivalued claim key behaves differently and
    // is not the intended control. Assert the exact operator, not just substring
    // presence of the workflow ref, so a regression to plain StringEquals is caught.
    build('prod', 'prodq').hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'example-svc-github-deploy-prod',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Condition: Match.objectLike({
              'ForAnyValue:StringEquals': {
                'token.actions.githubusercontent.com:job_workflow_ref': [
                  'example-org/example-repo/.github/workflows/deploy.yml@refs/heads/main',
                  'example-org/example-repo/.github/workflows/deploy-infra.yml@refs/heads/main',
                ],
              },
            }),
          }),
        ]),
      }),
    })
  })

  it('scopes the deploy role to ONLY its own stage bootstrap qualifier', () => {
    // One shared qualifier means dev's role can deploy prod (SEC-3).
    const json = JSON.stringify(build('dev', 'devq').findResources('AWS::IAM::Role'))
    expect(json).toContain('cdk-devq-deploy-role')
    expect(json).not.toContain('cdk-prodq-')
    expect(json).not.toContain('cdk-hnb659fds-')
  })

  it('rejects a qualifier longer than 10 chars even though it is alphanumeric', () => {
    // 12 alphanumeric chars — must fail on LENGTH, not be confused with the
    // separate non-alphanumeric case below.
    expect(() => build('dev', 'devqdevqdev1')).toThrow(/qualifier/i)
  })

  it('rejects a qualifier containing non-alphanumeric characters', () => {
    // 5 chars, within the length limit, but the underscore is not alphanumeric.
    expect(() => build('dev', 'dev_q')).toThrow(/qualifier/i)
  })

  it('gives the PR diff role — and ONLY the diff role — explicit Deny on data-reading actions', () => {
    // cdk diff runs attacker-authored TypeScript; ReadOnlyAccess would expose
    // lambda:GetFunction (presigned URL to the source zip) and s3:GetObject (SEC-2).
    // NOTE: `inlinePolicies` on RoleProps synthesizes as an embedded `Policies` array
    // on the AWS::IAM::Role resource itself in aws-cdk-lib 2.262.1 — not as a
    // standalone AWS::IAM::Policy resource (that form only appears via
    // `role.attachInlinePolicy()`).
    const template = build('dev', 'devq')

    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'example-svc-github-cdk-diff',
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Effect: 'Deny',
                Action: Match.arrayWith(['lambda:GetFunction', 'secretsmanager:GetSecretValue']),
                Resource: '*',
              }),
            ]),
          }),
        }),
      ]),
    })

    // The Deny must not have migrated onto the deploy role — its inline policy is
    // ONLY the CDK-bootstrap AssumeRole statement, with no Deny statement at all.
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'example-svc-github-deploy-dev',
      Policies: [
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: [Match.objectLike({ Effect: 'Allow', Action: 'sts:AssumeRole' })],
          }),
        }),
      ],
    })
  })

  it('creates the diff role only on dev', () => {
    expect(Object.keys(build('prod', 'prodq').findResources('AWS::IAM::Role'))).toHaveLength(1)
    expect(Object.keys(build('dev', 'devq').findResources('AWS::IAM::Role'))).toHaveLength(2)
  })
})
