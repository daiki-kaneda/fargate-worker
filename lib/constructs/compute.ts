import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

/** CloudFormation で公開される Dashboard の URL 用 */
const DASHBOARD_NAME = 'FargateWorker';

export interface ComputeProps {
  queue: sqs.Queue;
  pdfBucket: s3.Bucket;
  audioBucket: s3.Bucket;
  jobTable: dynamodb.Table;
  /** SES で検証済みの送信元メールアドレス。Fargate タスクの環境変数に渡される。 */
  senderEmailAddress: string;
  repository: ecr.Repository;
  taskRole: iam.Role;
}

/**
 * ECS Fargate サービス・Auto Scaling・CloudWatch 監視をまとめた Construct。
 *
 * スケーリング戦略 (Step Scaling のみ・L2 コンストラクト):
 *   - ScaleUp:     visible メッセージ数に応じ 6:1 の比率で 1 分以内にスケールアウト (0→N)
 *   - ScaleToZero: visible + notVisible = 0 が 5 分継続したらタスク数を 0 に設定
 *
 * コスト最適化として NAT Gateway を使わずパブリックサブネット + パブリック IP を採用。
 * ワーカーはリッスンポートを持たないためインバウンドルールは不要。
 */
export class Compute extends Construct {
  public readonly cluster: ecs.Cluster;
  public readonly service: ecs.FargateService;
  public readonly logGroup: logs.LogGroup;
  public readonly developerAlertTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ComputeProps) {
    super(scope, id);

    // --- VPC ---
    // NAT Gateway なし (月額 ~$32/AZ の削減)。タスクはパブリックサブネットに配置し
    // AssignPublicIp で AWS API・インターネットへのアウトバウンドを確保する。
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Gateway 型 VPC エンドポイント (無料・低遅延・S3/DynamoDB トラフィックがインターネットを経由しない)
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // インバウンドなし・アウトバウンド全許可 (ワーカーはリッスンポート不要)
    const taskSecurityGroup = new ec2.SecurityGroup(this, 'TaskSecurityGroup', {
      vpc,
      description: 'Fargate worker tasks: no inbound, all outbound allowed',
      allowAllOutbound: true,
    });

    // --- CloudWatch Log Group ---
    this.logGroup = new logs.LogGroup(this, 'WorkerLogGroup', {
      logGroupName: '/fargate-worker/worker',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Developer Alert Topic ---
    // ジョブ通知 (messaging.notificationTopic) とは分離した運用アラート専用トピック
    this.developerAlertTopic = new sns.Topic(this, 'DeveloperAlertTopic', {
      displayName: 'Fargate Worker Operational Alerts',
    });

    // --- ECS Cluster ---
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // --- Fargate Task Definition ---
    // 1 vCPU / 2 GB: 中程度の PDF (1〜5 MB) の処理に適したサイズ
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole: props.taskRole,
      // executionRole は CDK が自動生成 (ECR Pull + CloudWatch Logs 権限)
    });

    taskDefinition.addContainer('WorkerContainer', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'latest'),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'worker',
        logGroup: this.logGroup,
      }),
      environment: {
        QUEUE_URL: props.queue.queueUrl,
        PDF_BUCKET_NAME: props.pdfBucket.bucketName,
        AUDIO_BUCKET_NAME: props.audioBucket.bucketName,
        JOB_TABLE_NAME: props.jobTable.tableName,
        SENDER_EMAIL_ADDRESS: props.senderEmailAddress,
        AWS_DEFAULT_REGION: cdk.Stack.of(this).region,
        LOG_LEVEL: 'INFO',
        BEDROCK_MODEL_ID: 'jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
      },
    });

    // --- ECS Fargate Service ---
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 0,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSecurityGroup],
      assignPublicIp: true,
      // minHealthyPercent: 0 → デプロイ時に全タスクを入れ替え可能にする
      minHealthyPercent: 0,
      maxHealthyPercent: 200,
      circuitBreaker: { rollback: true },
    });

    this.configureAutoScaling(props.queue);
    this.dashboard = this.configureDashboard(props.queue);
    this.configureMonitoring();
  }

  /**
   * 2 つのステップスケーリングポリシーによるシンプルなスケーリング戦略。
   *
   * ① ScaleUp (EXACT_CAPACITY, cooldown: 1 分):
   *      visible メッセージ数に応じて 6:1 の比率でタスク数を決定する。
   *      0→N のスケールアウトを一本化し、実装を L2 コンストラクトのみで完結させる。
   *
   * ② ScaleToZero (EXACT_CAPACITY, cooldown: 5 分):
   *      visible + notVisible = 0 が 5 分継続したらタスク数を 0 に設定。
   *      notVisible > 0 (処理中) のうちはスケールダウンしない。
   */
  private configureAutoScaling(queue: sqs.Queue): void {
    const scalableTaskCount = this.service.autoScaleTaskCount({
      minCapacity: 0,
      maxCapacity: 10,
    });

    // ① 0 → N: Step Scaling (EXACT_CAPACITY, 比率 6:1)
    // visible メッセージ数の範囲に応じて絶対タスク数を指定する。
    // メッセージ数がゼロに戻ったとき ② が担当するため、スケールダウン方向の
    // ステップは意図的に含めない (EXACT_CAPACITY でゼロを設定すると
    // ScaleToZero と競合するため)。
    scalableTaskCount.scaleOnMetric('ScaleUp', {
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        dimensionsMap: { QueueName: queue.queueName },
        statistic: 'Maximum',
        period: cdk.Duration.minutes(1),
      }),
      scalingSteps: [
        { lower: 1,  change: 1  }, //  1〜5  件 →  1 タスク
        { lower: 6,  change: 2  }, //  6〜11 件 →  2 タスク
        { lower: 12, change: 3  }, // 12〜17 件 →  3 タスク
        { lower: 18, change: 4  }, // 18〜23 件 →  4 タスク
        { lower: 24, change: 5  }, // 24〜29 件 →  5 タスク
        { lower: 30, change: 6  }, // 30〜35 件 →  6 タスク
        { lower: 36, change: 7  }, // 36〜41 件 →  7 タスク
        { lower: 42, change: 8  }, // 42〜47 件 →  8 タスク
        { lower: 48, change: 9  }, // 48〜53 件 →  9 タスク
        { lower: 54, change: 10 }, // 54+   件 → 10 タスク
      ],
      adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
      cooldown: cdk.Duration.minutes(1),
      metricAggregationType: appscaling.MetricAggregationType.MAXIMUM,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
    });

    // ② N → 0: Step Scaling (EXACT_CAPACITY, 5 分待機)
    // visible + notVisible = 0 が 5 分継続してはじめて 0 タスクに設定。
    // notVisible > 0 (処理中メッセージあり) の間はスケールダウンしない。
    scalableTaskCount.scaleOnMetric('ScaleToZero', {
      metric: new cloudwatch.MathExpression({
        expression: 'visible + notVisible',
        usingMetrics: {
          visible: new cloudwatch.Metric({
            namespace: 'AWS/SQS',
            metricName: 'ApproximateNumberOfMessagesVisible',
            dimensionsMap: { QueueName: queue.queueName },
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
          }),
          notVisible: new cloudwatch.Metric({
            namespace: 'AWS/SQS',
            metricName: 'ApproximateNumberOfMessagesNotVisible',
            dimensionsMap: { QueueName: queue.queueName },
            statistic: 'Maximum',
            period: cdk.Duration.minutes(1),
          }),
        },
        period: cdk.Duration.minutes(1),
      }),
      scalingSteps: [
        { upper: 0, change: 0 }, // total = 0 → 0 タスク
        { lower: 1, change: 1 }, // total >= 1 → 1 タスク以上を維持
      ],
      adjustmentType: appscaling.AdjustmentType.EXACT_CAPACITY,
      cooldown: cdk.Duration.minutes(5),
      metricAggregationType: appscaling.MetricAggregationType.MAXIMUM,
      evaluationPeriods: 5,
      datapointsToAlarm: 5,
    });
  }

  /**
   * 主要なオペレーション指標を一覧できる CloudWatch Dashboard を作成する。
   *
   * ウィジェット構成:
   *   行 1: SQS visible / notVisible メッセージ数
   *   行 2: ECS 実行中タスク数 / カスタムエラーカウント
   */
  private configureDashboard(queue: sqs.Queue): cloudwatch.Dashboard {
    const visibleMessages = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: { QueueName: queue.queueName },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      label: 'Visible Messages',
    });

    const notVisibleMessages = new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesNotVisible',
      dimensionsMap: { QueueName: queue.queueName },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      label: 'In-Flight Messages',
    });

    const runningTaskCount = new cloudwatch.Metric({
      namespace: 'ECS/ContainerInsights',
      metricName: 'RunningTaskCount',
      dimensionsMap: {
        ClusterName: this.cluster.clusterName,
        ServiceName: this.service.serviceName,
      },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
      label: 'Running Tasks',
    });

    const errorCount = new cloudwatch.Metric({
      namespace: 'FargateWorker',
      metricName: 'ErrorCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(1),
      label: 'ERROR Logs / min',
    });

    return new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: DASHBOARD_NAME,
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'SQS Queue Depth',
            left: [visibleMessages],
            right: [notVisibleMessages],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'ECS Running Tasks',
            left: [runningTaskCount],
            width: 6,
          }),
          new cloudwatch.GraphWidget({
            title: 'Worker ERROR Logs',
            left: [errorCount],
            width: 6,
          }),
        ],
      ],
    });
  }

  /**
   * 構造化 JSON ログの ERROR レベルをカウントするメトリクスフィルターと、
   * エラー急増時の開発者通知アラームを設定する。
   *
   * ワーカーは { "level": "ERROR", ... } 形式で stdout に出力する前提。
   */
  private configureMonitoring(): void {
    const errorMetricFilter = new logs.MetricFilter(this, 'ErrorMetricFilter', {
      logGroup: this.logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'ERROR'),
      metricNamespace: 'FargateWorker',
      metricName: 'ErrorCount',
      defaultValue: 0,
      metricValue: '1',
    });

    const errorCountMetric = errorMetricFilter.metric({
      period: cdk.Duration.minutes(1),
      statistic: 'Sum',
    });

    // 1 分間に ERROR ログが 5 件以上発生したら開発者に通知
    const highErrorRateAlarm = new cloudwatch.Alarm(this, 'HighErrorRateAlarm', {
      metric: errorCountMetric,
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Fargate worker: 5+ ERROR logs within 1 minute',
    });

    highErrorRateAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.developerAlertTopic),
    );
    // アラーム解消時にも通知して復旧を把握できるようにする
    highErrorRateAlarm.addOkAction(
      new cloudwatchActions.SnsAction(this.developerAlertTopic),
    );
  }
}
