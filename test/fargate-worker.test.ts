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

describe('Messaging', () => {
  test('SQS queue has 30-minute visibility timeout and long polling', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 1800,         // 30 minutes
      ReceiveMessageWaitTimeSeconds: 20,
    });
  });

  test('DLQ exists with 14-day retention', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::SQS::Queue', 2); // queue + dlq
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 1209600, // 14 days
    });
  });

  test('Main queue has a redrive policy pointing to the DLQ', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  test('SNS topic is created', () => {
    const template = buildTemplate();
    template.resourceCountIs('AWS::SNS::Topic', 1);
  });
});

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

describe('Registry', () => {
  test('ECR repository has image scan on push enabled', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageScanningConfiguration: { ScanOnPush: true },
    });
  });

  test('Fargate task role allows SQS, S3, DynamoDB, Bedrock, Polly, SNS', () => {
    const template = buildTemplate();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'SqsAccess' }),
          Match.objectLike({ Sid: 'S3Access' }),
          Match.objectLike({ Sid: 'DynamoDbAccess' }),
          Match.objectLike({ Sid: 'BedrockAccess' }),
          Match.objectLike({ Sid: 'PollyAccess' }),
          Match.objectLike({ Sid: 'SnsPublish' }),
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
      'NotificationTopicArn',
      'WorkerRepositoryUri',
      'TaskRoleArn',
    ];
    required.forEach((key) => {
      expect(outputKeys).toContain(key);
    });
  });
});
