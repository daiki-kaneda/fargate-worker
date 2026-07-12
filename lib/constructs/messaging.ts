import * as cdk from 'aws-cdk-lib/core';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/**
 * SQS キュー・DLQ・SNS 通知トピックをまとめた Construct。
 *
 * Visibility Timeout を 30 分に設定し、長時間かかる処理
 * (PDF ダウンロード + Bedrock + Polly) でのメッセージ二重処理を防ぐ。
 * ワーカーは処理中に ChangeMessageVisibility で定期的に延長する。
 */
export class Messaging extends Construct {
  public readonly queue: sqs.Queue;
  public readonly dlq: sqs.Queue;
  public readonly notificationTopic: sns.Topic;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.dlq = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.queue = new sqs.Queue(this, 'Queue', {
      // 30分: PDF取得 + Bedrock (要約・SSML変換) + Polly の最大処理時間を考慮
      visibilityTimeout: cdk.Duration.minutes(30),
      // Long polling でコストを削減
      receiveMessageWaitTime: cdk.Duration.seconds(20),
      retentionPeriod: cdk.Duration.days(14),
      deadLetterQueue: {
        queue: this.dlq,
        maxReceiveCount: 3,
      },
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.notificationTopic = new sns.Topic(this, 'NotificationTopic', {
      displayName: 'Paper Summarization Job Notifications',
    });
  }
}
