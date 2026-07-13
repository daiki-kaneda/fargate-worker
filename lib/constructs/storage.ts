import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

/**
 * S3 バケット (PDF・音声) と DynamoDB ジョブテーブルをまとめた Construct。
 *
 * DynamoDB テーブルはジョブの進捗をステップ単位で記録し、
 * 途中失敗時に同ステップから再開できる構造にしている。
 * messageId GSI により SQS メッセージの冪等処理に対応する。
 */
export class Storage extends Construct {
  public readonly pdfBucket: s3.Bucket;
  public readonly audioBucket: s3.Bucket;
  public readonly jobTable: dynamodb.Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.pdfBucket = new s3.Bucket(this, 'PdfBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-pdfs-after-30-days',
          expiration: cdk.Duration.days(30),
        },
      ],
    });

    this.audioBucket = new s3.Bucket(this, 'AudioBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-audio-after-90-days',
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    this.jobTable = new dynamodb.Table(this, 'JobTable', {
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // 処理完了後のレコードを自動削除 (TTL はワーカーが設定)
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // SQS messageId による冪等性チェック用 GSI
    this.jobTable.addGlobalSecondaryIndex({
      indexName: 'messageId-index',
      partitionKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
  }
}
