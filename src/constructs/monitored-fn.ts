import { Duration, RemovalPolicy } from 'aws-cdk-lib'
import { Alarm, ComparisonOperator, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch'
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions'
import type { IKey } from 'aws-cdk-lib/aws-kms'
import { Runtime } from 'aws-cdk-lib/aws-lambda'
import { SqsDestination } from 'aws-cdk-lib/aws-lambda-destinations'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager'
import type { ITopic } from 'aws-cdk-lib/aws-sns'
import { Queue } from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'
import type { StageConfig, StageName } from '../stages'

export interface MonitoredFnProps {
  readonly entry: string
  readonly handler?: string
  readonly stage: StageName
  readonly cfg: StageConfig
  /** REQUIRED. An alarm with no action is silent — the bug this library exists to prevent. */
  readonly alertsTopic: ITopic
  readonly environment?: Record<string, string>
  readonly timeout?: Duration
  readonly memorySize?: number
  readonly secrets?: readonly ISecret[]
  readonly logEncryptionKey?: IKey
}

const RETENTION: Record<7 | 30 | 90, RetentionDays> = {
  7: RetentionDays.ONE_WEEK,
  30: RetentionDays.ONE_MONTH,
  90: RetentionDays.THREE_MONTHS,
}

/**
 * A Node 24 Lambda that cannot exist without: an explicit encrypted log group with
 * stage-appropriate retention, a dead letter queue, and Errors / Duration-p99 /
 * Throttles / DLQ-depth alarms all wired to a real SNS topic.
 */
export class MonitoredFn extends Construct {
  public readonly fn: NodejsFunction
  public readonly logGroup: LogGroup
  public readonly dlq: Queue

  constructor(scope: Construct, id: string, props: MonitoredFnProps) {
    super(scope, id)

    this.dlq = new Queue(this, 'Dlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    })

    // Explicit log group, NOT the deprecated `logRetention` prop: that provisions a
    // singleton custom-resource Lambda holding logs:PutRetentionPolicy on "*" (SEC-5).
    this.logGroup = new LogGroup(this, 'Logs', {
      retention: RETENTION[props.cfg.logRetentionDays],
      encryptionKey: props.logEncryptionKey,
      removalPolicy: props.stage === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    })

    this.fn = new NodejsFunction(this, 'Fn', {
      entry: props.entry,
      handler: props.handler ?? 'handler',
      runtime: Runtime.NODEJS_24_X,
      timeout: props.timeout ?? Duration.seconds(15),
      memorySize: props.memorySize ?? 512,
      reservedConcurrentExecutions: props.cfg.reservedConcurrency,
      logGroup: this.logGroup,
      onFailure: new SqsDestination(this.dlq),
      maxEventAge: Duration.hours(2),
      retryAttempts: 2,
      environment: {
        STAGE: props.stage,
        LOG_LEVEL: props.cfg.logLevel,
        ...props.environment,
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        minify: false,
        sourceMap: true,
        // esbuild's ESM output rewrites require() into a shim that throws
        // "Dynamic require of X is not supported". Inject a real require so bundled
        // CJS deps work at cold start. Still required — no built-in CDK option exists.
        banner:
          "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
    })

    for (const secret of props.secrets ?? []) {
      secret.grantRead(this.fn)
    }

    const action = new SnsAction(props.alertsTopic)

    const alarm = (a: Alarm): Alarm => {
      a.addAlarmAction(action)
      return a
    }

    alarm(
      new Alarm(this, 'ErrorsAlarm', {
        metric: this.fn.metricErrors({ period: Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 5,
        datapointsToAlarm: 1, // SEC-7: catch a single bad minute, not five consecutive
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    )

    alarm(
      new Alarm(this, 'DurationP99Alarm', {
        metric: this.fn.metricDuration({ period: Duration.minutes(5), statistic: 'p99' }),
        threshold: 3_000,
        evaluationPeriods: 3,
        datapointsToAlarm: 2,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    )

    alarm(
      new Alarm(this, 'ThrottlesAlarm', {
        metric: this.fn.metricThrottles({ period: Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 5,
        datapointsToAlarm: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    )

    alarm(
      new Alarm(this, 'DlqDepthAlarm', {
        metric: this.dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }),
    )
  }
}
