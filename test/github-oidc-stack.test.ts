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

  it('pins job_workflow_ref to the exact workflow file and branch', () => {
    const json = JSON.stringify(build('prod', 'prodq').findResources('AWS::IAM::Role'))
    expect(json).toContain('example-org/example-repo/.github/workflows/deploy.yml@refs/heads/main')
  })

  it('scopes the deploy role to ONLY its own stage bootstrap qualifier', () => {
    // One shared qualifier means dev's role can deploy prod (SEC-3).
    const json = JSON.stringify(build('dev', 'devq').findResources('AWS::IAM::Role'))
    expect(json).toContain('cdk-devq-deploy-role')
    expect(json).not.toContain('cdk-prodq-')
    expect(json).not.toContain('cdk-hnb659fds-')
  })

  it('rejects an invalid bootstrap qualifier', () => {
    expect(() => build('dev', 'this-is-way-too-long')).toThrow(/qualifier/i)
  })

  it('gives the PR diff role explicit Deny on data-reading actions', () => {
    // cdk diff runs attacker-authored TypeScript; ReadOnlyAccess would expose
    // lambda:GetFunction (presigned URL to the source zip) and s3:GetObject (SEC-2).
    // NOTE: `inlinePolicies` on RoleProps synthesizes as an embedded `Policies` array
    // on the AWS::IAM::Role resource itself in aws-cdk-lib 2.262.1 — not as a
    // standalone AWS::IAM::Policy resource (that form only appears via
    // `role.attachInlinePolicy()`). The brief's test queried AWS::IAM::Policy, which
    // is always empty here; querying AWS::IAM::Role asserts the identical content.
    const json = JSON.stringify(build('dev', 'devq').findResources('AWS::IAM::Role'))
    expect(json).toContain('Deny')
    expect(json).toContain('lambda:GetFunction')
    expect(json).toContain('secretsmanager:GetSecretValue')
  })

  it('creates the diff role only on dev', () => {
    expect(Object.keys(build('prod', 'prodq').findResources('AWS::IAM::Role'))).toHaveLength(1)
    expect(Object.keys(build('dev', 'devq').findResources('AWS::IAM::Role'))).toHaveLength(2)
  })
})
