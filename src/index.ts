import { createConfig } from './infrastructure/config/Config';
import { createLogger } from './shared/logger/Logger';
import { SqsMessageQueue } from './infrastructure/aws/SqsMessageQueue';
import { S3PdfRepository } from './infrastructure/aws/S3PdfRepository';
import { DynamoDbJobRepository } from './infrastructure/aws/DynamoDbJobRepository';
import { BedrockSummarizer } from './infrastructure/aws/BedrockSummarizer';
import { BedrockSsmlConverter } from './infrastructure/aws/BedrockSsmlConverter';
import { PollyAudioGenerator } from './infrastructure/aws/PollyAudioGenerator';
import { SesNotification } from './infrastructure/aws/SesNotification';
import { ProcessJobUseCase } from './application/usecases/ProcessJobUseCase';

async function main(): Promise<void> {
  const config = createConfig();
  const logger = createLogger(config.logLevel);

  logger.info({ msg: 'Worker starting', region: config.awsRegion, modelId: config.bedrockModelId });

  // ─── Infrastructure の組み立て ───────────────────────────────────────────
  const messageQueue = new SqsMessageQueue(config.queueUrl, logger);
  const pdfRepository = new S3PdfRepository(config.pdfBucketName, logger);
  const jobRepository = new DynamoDbJobRepository(config.jobTableName, logger);
  const summarizer = new BedrockSummarizer(config.bedrockModelId, logger);
  const ssmlConverter = new BedrockSsmlConverter(config.bedrockModelId, logger);
  const audioGenerator = new PollyAudioGenerator(config.audioBucketName, logger);
  const notification = new SesNotification(
    config.senderEmailAddress,
    config.audioBucketName,
    config.presignedUrlExpiresIn,
    logger,
  );

  // ─── Use Case の組み立て（DI）────────────────────────────────────────────
  const processJob = new ProcessJobUseCase(
    messageQueue,
    pdfRepository,
    jobRepository,
    summarizer,
    ssmlConverter,
    audioGenerator,
    notification,
    logger,
  );

  logger.info({ msg: 'Worker started — beginning SQS polling loop' });

  // ─── メインポーリングループ ──────────────────────────────────────────────
  while (true) {
    try {
      await processJob.execute();
    } catch (err) {
      // ジョブ単位の失敗はログ済み。ECS が再起動すべき致命的エラーでなければ続行する。
      logger.warn({ msg: 'Job execution error — continuing polling', error: String(err) });
    }
  }
}

main().catch((err) => {
  // Config 読み込み失敗など起動時の致命的エラー
  console.error(JSON.stringify({ level: 'ERROR', msg: 'Fatal startup error', error: String(err) }));
  process.exit(1);
});
