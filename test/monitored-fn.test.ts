import { App, Stack } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { describe, expect, it } from 'vitest'
import { MonitoredFn } from '../src/constructs/monitored-fn'
import { defineStages } from '../src/stages'

const cfg = defineStages({ dev: 25, stg: 50, prod: 200 }).prod

function build() {
  const app = new App()
  const stack = new Stack(app, 'T', { env: { account: '111111111111', region: 'us-east-1' } })
  const topic = new Topic(stack, 'Alerts')
  new MonitoredFn(stack, 'Health', {
    entry: `${__dirname}/fixtures/handler.ts`,
    stage: 'prod',
    cfg,
    alertsTopic: topic,
  })
  return Template.fromStack(stack)
}

describe('MonitoredFn', () => {
  it('runs on Node 24', () => {
    build().hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs24.x' })
  })

  it('creates an explicit log group with the stage retention — never CDK "forever"', () => {
    // 90 days for prod. An absent RetentionInDays means logs are kept forever (SEC-5).
    build().hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 90 })
  })

  it('does NOT use the deprecated logRetention custom resource', () => {
    // logRetention provisions a singleton Lambda whose role holds
    // logs:PutRetentionPolicy on "*" — account-wide log tampering (SEC-5).
    const fns = build().findResources('AWS::Lambda::Function')
    const names = Object.values(fns).map((f) => JSON.stringify(f))
    expect(names.some((n) => n.includes('LogRetention'))).toBe(false)
  })

  it('wires EVERY alarm to the alerts topic', () => {
    const alarms = build().findResources('AWS::CloudWatch::Alarm')
    expect(Object.keys(alarms).length).toBeGreaterThanOrEqual(3)
    for (const alarm of Object.values(alarms)) {
      expect(
        alarm.Properties.AlarmActions,
        JSON.stringify(alarm.Properties.AlarmName),
      ).toBeDefined()
      expect(alarm.Properties.AlarmActions.length).toBeGreaterThan(0)
    }
  })

  it('fires the errors alarm on a single bad minute, not five consecutive ones', () => {
    // threshold 1 + evaluationPeriods 5 without DatapointsToAlarm needs five
    // CONSECUTIVE bad minutes; a 1000-error burst then silence never fires (SEC-7).
    build().hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      DatapointsToAlarm: 1,
    })
  })

  it('alarms on throttles', () => {
    build().hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'Throttles' })
  })

  it('gives async invocations a dead letter queue', () => {
    build().hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
      MaximumRetryAttempts: 2,
    })
  })
})
