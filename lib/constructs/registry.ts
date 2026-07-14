import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface RegistryProps {
  queue: sqs.Queue;
  dlq: sqs.Queue;
  pdfBucket: s3.Bucket;
  audioBucket: s3.Bucket;
  jobTable: dynamodb.Table;
}

/**
 * ECR リポジトリと Fargate タスクロールをまとめた Construct。
 *
 * タスクロールは最小権限の原則に基づき、各リソースへの
 * 必要最低限のアクションのみを許可する。
 */
export class Registry extends Construct {
  public readonly repository: ecr.Repository;
  public readonly taskRole: iam.Role;

  constructor(scope: Construct, id: string, props: RegistryProps) {
    super(scope, id);

    this.repository = new ecr.Repository(this, 'WorkerRepository', {
      imageScanOnPush: true,
      lifecycleRules: [
        {
          maxImageCount: 10,
          description: 'Keep only the 10 most recent images',
        },
      ],
    });

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'IAM role assumed by the Fargate worker task',
    });

    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SqsAccess',
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:ChangeMessageVisibility',
          'sqs:GetQueueAttributes',
        ],
        resources: [props.queue.queueArn, props.dlq.queueArn],
      }),
    );

    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3Access',
        actions: ['s3:PutObject', 's3:GetObject'],
        resources: [
          `${props.pdfBucket.bucketArn}/*`,
          `${props.audioBucket.bucketArn}/*`,
        ],
      }),
    );

    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DynamoDbAccess',
        actions: [
          'dynamodb:PutItem',
          'dynamodb:GetItem',
          'dynamodb:UpdateItem',
          'dynamodb:Query',
        ],
        resources: [
          props.jobTable.tableArn,
          `${props.jobTable.tableArn}/index/*`,
        ],
      }),
    );

    // ap リージョンのクロスリージョン推論プロファイルを含む
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BedrockAccess',
        actions: ['bedrock:InvokeModel'],
        resources: [
          'arn:aws:bedrock:*::foundation-model/anthropic.claude-3-5-*',
          `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/apac.anthropic.claude-3-5-*`,
        ],
      }),
    );

    // Polly はリソースレベルの制御をサポートしないため '*' を使用
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PollyAccess',
        actions: [
          'polly:SynthesizeSpeech',
          'polly:StartSpeechSynthesisTask',
          'polly:GetSpeechSynthesisTask',
        ],
        resources: ['*'],
      }),
    );

    // SES はリソースレベルの制御がアイデンティティ ARN 単位だが、
    // 送信元アドレスは実行時に環境変数で渡されるため '*' で許可する。
    // 最小権限が必要な場合は 'arn:aws:ses:REGION:ACCOUNT:identity/SENDER' に絞ること。
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SesAccess',
        actions: ['ses:SendEmail'],
        resources: ['*'],
      }),
    );
  }
}
