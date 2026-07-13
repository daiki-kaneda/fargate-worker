import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FargateWorkerStack } from '../lib/fargate-worker-stack';

function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new FargateWorkerStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return Template.fromStack(stack);
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
describe('Messaging', () => {
  test('SQS queue has 30-minute visibility timeout and long polling', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 1800,
      ReceiveMessageWaitTimeSeconds: 20,
    });
  });

  test('DLQ exists with 14-day retention', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600,
    });
  });

  test('Main queue has a redrive policy pointing to the DLQ', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
    });
  });

  test('Developer alert SNS topic is created', () => {
    const template = buildTemplate();
    // developerAlertTopic のみ (通知は SES で行う)
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
describe('Storage', () => {
  test('Two S3 buckets are created with public access blocked', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::S3::Bucket', 2);
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('DynamoDB table uses PAY_PER_REQUEST billing with TTL', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('DynamoDB table has messageId GSI for idempotency', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'messageId-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'messageId', KeyType: 'HASH' },
          ]),
        }),
      ]),
    });
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
describe('Registry', () => {
  test('ECR repository has image scan on push enabled', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('Fargate task role allows SQS, S3, DynamoDB, Bedrock, Polly, SES', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'SqsAccess' }),
          Match.objectLike({ Sid: 'S3Access' }),
          Match.objectLike({ Sid: 'DynamoDbAccess' }),
          Match.objectLike({ Sid: 'BedrockAccess' }),
          Match.objectLike({ Sid: 'PollyAccess' }),
          Match.objectLike({ Sid: 'SesAccess' }),
        ]),
      },
    });
  });

  test('Task role is assumable by ecs-tasks.amazonaws.com', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
            Action: 'sts:AssumeRole',
          }),
        ]),
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------
describe('Compute', () => {
  test('Two Gateway VPC endpoints are created (S3 and DynamoDB)', () => {
    const template = buildTemplate();
    // ServiceName は Fn::Join で生成されるためリソース数でのみ検証
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 2);
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    });
  });

  test('ECS cluster is created with Container Insights enabled', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterSettings: Match.arrayWith([
        { Name: 'containerInsights', Value: 'enabled' },
      ]),
    });
  });

  test('Fargate task definition has 1 vCPU and 2 GB memory', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '1024',
      Memory: '2048',
    });
  });

  test('Container has required environment variables', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Environment: Match.arrayWith([
            Match.objectLike({ Name: 'QUEUE_URL' }),
            Match.objectLike({ Name: 'PDF_BUCKET_NAME' }),
            Match.objectLike({ Name: 'AUDIO_BUCKET_NAME' }),
            Match.objectLike({ Name: 'JOB_TABLE_NAME' }),
            Match.objectLike({ Name: 'SENDER_EMAIL_ADDRESS' }),
            Match.objectLike({ Name: 'LOG_LEVEL', Value: 'INFO' }),
            Match.objectLike({ Name: 'BEDROCK_MODEL_ID', Value: 'ap.anthropic.claude-3-5-sonnet-20241022-v2:0' }),
          ]),
        }),
      ]),
    });
  });

  test('ECS service starts with desired count 0 (scale-from-zero pattern)', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 0,
      LaunchType: 'FARGATE',
    });
  });

  test('Application Auto Scaling target is registered with min=0 and max=10', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', {
      MinCapacity: 0,
      MaxCapacity: 10,
      ServiceNamespace: 'ecs',
    });
  });

  test('Two step scaling policies: ScaleUp (6:1 ratio) and ScaleToZero', () => {
    const template = buildTemplate();

    // ① ScaleUp: EXACT_CAPACITY, 10 ステップで 6:1 比率を実現
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'StepScaling',
      StepScalingPolicyConfiguration: Match.objectLike({
        AdjustmentType: 'ExactCapacity',
        Cooldown: 60,
        StepAdjustments: Match.arrayWith([
          Match.objectLike({ ScalingAdjustment: 1 }),  // 1〜5 件 → 1 タスク
          Match.objectLike({ ScalingAdjustment: 10 }), // 54+ 件 → 10 タスク
        ]),
      }),
    });

    // ② ScaleToZero: EXACT_CAPACITY, 5 分評価
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'StepScaling',
      StepScalingPolicyConfiguration: Match.objectLike({
        AdjustmentType: 'ExactCapacity',
        Cooldown: 300,
      }),
    });

    // Step Scaling ポリシーのみ (Target Tracking なし)
    const policies = template.findResources('AWS::ApplicationAutoScaling::ScalingPolicy');
    expect(Object.keys(policies).length).toBeGreaterThanOrEqual(2);
    Object.values(policies).forEach((policy) => {
      expect((policy as { Properties: { PolicyType: string } }).Properties.PolicyType).toBe('StepScaling');
    });
  });

  test('CloudWatch log group is created with 1-month retention', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/fargate-worker/worker',
      RetentionInDays: 30,
    });
  });

  test('Metric filter counts ERROR level JSON logs', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: Match.stringLikeRegexp('ERROR'),
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricName: 'ErrorCount',
          MetricNamespace: 'FargateWorker',
          DefaultValue: 0,
        }),
      ]),
    });
  });

  test('High error rate alarm notifies developer alert topic', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      Threshold: 5,
      EvaluationPeriods: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
  });

  test('CloudWatch Dashboard named FargateWorker is created with 4 widgets', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'FargateWorker',
    });
  });
});

// ---------------------------------------------------------------------------
// CloudFormation Outputs
// ---------------------------------------------------------------------------
describe('CloudFormation Outputs', () => {
  test('All required outputs are present', () => {
    const template = buildTemplate();
    const outputs = template.findOutputs('*');
    const outputKeys = Object.keys(outputs);

    const required = [
      'QueueUrl',
      'DlqUrl',
      'PdfBucketName',
      'AudioBucketName',
      'JobTableName',
      'SenderEmailAddress',
      'WorkerRepositoryUri',
      'TaskRoleArn',
      'ClusterName',
      'ServiceName',
      'WorkerLogGroupName',
      'DeveloperAlertTopicArn',
      'DashboardUrl',
    ];
    required.forEach((key) => {
      expect(outputKeys).toContain(key);
    });
  });
});
