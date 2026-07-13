import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { Messaging } from './constructs/messaging';
import { Storage } from './constructs/storage';
import { Registry } from './constructs/registry';
import { Compute } from './constructs/compute';

export class FargateWorkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // デプロイ時に指定する SES 検証済み送信元メールアドレス。
    // 例: cdk deploy --parameters SenderEmail=noreply@yourdomain.com
    const senderEmailParam = new cdk.CfnParameter(this, 'SenderEmail', {
      type: 'String',
      description: 'SES-verified sender email address for job notifications',
      allowedPattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$',
    });

    const messaging = new Messaging(this, 'Messaging');
    const storage = new Storage(this, 'Storage');
    const registry = new Registry(this, 'Registry', {
      queue: messaging.queue,
      dlq: messaging.dlq,
      pdfBucket: storage.pdfBucket,
      audioBucket: storage.audioBucket,
      jobTable: storage.jobTable,
    });
    const compute = new Compute(this, 'Compute', {
      queue: messaging.queue,
      pdfBucket: storage.pdfBucket,
      audioBucket: storage.audioBucket,
      jobTable: storage.jobTable,
      senderEmailAddress: senderEmailParam.valueAsString,
      repository: registry.repository,
      taskRole: registry.taskRole,
    });

    // --- CloudFormation Outputs ---

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

    new cdk.CfnOutput(this, 'SenderEmailAddress', {
      value: senderEmailParam.valueAsString,
      description: 'SES sender email address for job notifications',
      exportName: `${this.stackName}-SenderEmailAddress`,
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

    new cdk.CfnOutput(this, 'ClusterName', {
      value: compute.cluster.clusterName,
      description: 'ECS cluster name',
      exportName: `${this.stackName}-ClusterName`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: compute.service.serviceName,
      description: 'ECS service name',
      exportName: `${this.stackName}-ServiceName`,
    });

    new cdk.CfnOutput(this, 'WorkerLogGroupName', {
      value: compute.logGroup.logGroupName,
      description: 'CloudWatch log group name for worker logs',
      exportName: `${this.stackName}-WorkerLogGroupName`,
    });

    new cdk.CfnOutput(this, 'DeveloperAlertTopicArn', {
      value: compute.developerAlertTopic.topicArn,
      description: 'SNS topic ARN for developer operational alerts',
      exportName: `${this.stackName}-DeveloperAlertTopicArn`,
    });
  }
}
