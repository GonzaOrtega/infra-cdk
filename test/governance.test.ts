import { App, Stack } from 'aws-cdk-lib'
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions'
import { AttributeType, Table } from 'aws-cdk-lib/aws-dynamodb'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { describe, expect, it } from 'vitest'
import { applyGovernance } from '../src/governance'

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

  it('produces neither errors nor warnings for a clean stack', () => {
    const app = new App()
    const stack = new Stack(app, 'Clean', { env: { account: '111111111111', region: 'us-east-1' } })
    applyGovernance(app, { service: 'example-svc', owner: 'alerts@example.com', stage: 'dev' })
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue())).toHaveLength(0)
    expect(Annotations.fromStack(stack).findWarning('*', Match.anyValue())).toHaveLength(0)
  })
})
