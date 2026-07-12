import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Messaging } from './constructs/messaging';
import { Storage } from './constructs/storage';
import { Registry } from './constructs/registry';

export class FargateWorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const messaging = new Messaging(this, 'Messaging');
    const storage = new Storage(this, 'Storage');
    const registry = new Registry(this, 'Registry', {
      queue: messaging.queue,
      dlq: messaging.dlq,
      pdfBucket: storage.pdfBucket,
      audioBucket: storage.audioBucket,
      jobTable: storage.jobTable,
      notificationTopic: messaging.notificationTopic,
    });

    // --- CloudFormation Outputs ---
    // ワーカーコンテナの環境変数などでの参照に使用するための出力

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: messaging.queue.queueUrl,
      description: 'SQS queue URL for summarization jobs',
      exportName: `${this.stackName}-QueueUrl`,
    });

    new cdk.CfnOutput(this, 'DlqUrl', {
      value: messaging.dlq.queueUrl,
      description: 'SQS dead letter queue URL',
      exportName: `${this.stackName}-DlqUrl`,
    });

    new cdk.CfnOutput(this, 'PdfBucketName', {
      value: storage.pdfBucket.bucketName,
      description: 'S3 bucket name for PDF storage',
      exportName: `${this.stackName}-PdfBucketName`,
    });

    new cdk.CfnOutput(this, 'AudioBucketName', {
      value: storage.audioBucket.bucketName,
      description: 'S3 bucket name for audio file storage',
      exportName: `${this.stackName}-AudioBucketName`,
    });

    new cdk.CfnOutput(this, 'JobTableName', {
      value: storage.jobTable.tableName,
      description: 'DynamoDB table name for job tracking',
      exportName: `${this.stackName}-JobTableName`,
    });

    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: messaging.notificationTopic.topicArn,
      description: 'SNS topic ARN for job notifications',
      exportName: `${this.stackName}-NotificationTopicArn`,
    });

    new cdk.CfnOutput(this, 'WorkerRepositoryUri', {
      value: registry.repository.repositoryUri,
      description: 'ECR repository URI for the worker image',
      exportName: `${this.stackName}-WorkerRepositoryUri`,
    });

    new cdk.CfnOutput(this, 'TaskRoleArn', {
      value: registry.taskRole.roleArn,
      description: 'IAM task role ARN for Fargate tasks',
      exportName: `${this.stackName}-TaskRoleArn`,
    });
  }
}
