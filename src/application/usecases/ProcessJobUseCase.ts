import { MessageQueuePort } from '../../domain/ports/MessageQueuePort';
import { PdfRepositoryPort } from '../../domain/ports/PdfRepositoryPort';
import { JobRepositoryPort } from '../../domain/ports/JobRepositoryPort';
import { SummarizerPort } from '../../domain/ports/SummarizerPort';
import { SsmlConverterPort } from '../../domain/ports/SsmlConverterPort';
import { AudioGeneratorPort } from '../../domain/ports/AudioGeneratorPort';
import { NotificationPort } from '../../domain/ports/NotificationPort';
import { SummarizationMessageSchema, SummarizationMessageDto } from '../dtos/SummarizationMessageDto';
import { SummarizationMessageMapper } from '../mappers/SummarizationMessageMapper';
import { Logger } from '../../shared/logger/Logger';

/**
 * 1 件の SQS メッセージを受け取り、論文要約パイプラインを実行するユースケース。
 *
 * 処理ステップ:
 *   1. SQS メッセージを受信・パース・バリデーション
 *   2. 冪等性チェック（同一 messageId が既に COMPLETED なら再処理しない）
 *   3. DynamoDB にジョブレコードを初期化
 *   4. PDF を S3 へダウンロード保存
 *   5. Bedrock で要約生成
 *   6. Bedrock で SSML 変換
 *   7. Polly で音声合成 → S3 保存
 *   8. SNS で成功通知（署名付き URL 付き）
 *   9. SQS メッセージ削除
 *
 * 失敗時は SNS で失敗通知を送りメッセージを削除せず DLQ へ委ねる。
 */
export class ProcessJobUseCase {
  constructor(
    private readonly messageQueue: MessageQueuePort,
    private readonly pdfRepository: PdfRepositoryPort,
    private readonly jobRepository: JobRepositoryPort,
    private readonly summarizer: SummarizerPort,
    private readonly ssmlConverter: SsmlConverterPort,
    private readonly audioGenerator: AudioGeneratorPort,
    private readonly notification: NotificationPort,
    private readonly logger: Logger,
  ) {}

  async execute(): Promise<void> {
    // ─── Step 1: SQS Long Polling ───────────────────────────────────────────
    const messages = await this.messageQueue.receiveMessages(1);
    if (messages.length === 0) return;

    const raw = messages[0];
    const jobLogger = this.logger.child({ messageId: raw.messageId });
    jobLogger.info({ msg: 'Message received from SQS' });

    // ─── Step 2: メッセージのパース・バリデーション ──────────────────────────
    let rawBody: unknown;
    try {
      rawBody = JSON.parse(raw.body);
    } catch (err) {
      jobLogger.error({ msg: 'Failed to parse SQS message body as JSON — discarding', error: String(err) });
      await this.messageQueue.deleteMessage(raw.receiptHandle);
      return;
    }

    const parsed = SummarizationMessageSchema.safeParse(rawBody);
    if (!parsed.success) {
      jobLogger.error({
        msg: 'Invalid SQS message body — discarding',
        issues: parsed.error.issues,
      });
      await this.messageQueue.deleteMessage(raw.receiptHandle);
      return;
    }

    const input: SummarizationMessageDto = parsed.data;
    const log = jobLogger.child({ jobId: input.jobId });

    // ─── Step 3: 冪等性チェック ──────────────────────────────────────────────
    const existing = await this.jobRepository.findByMessageId(raw.messageId);
    if (existing?.isCompleted()) {
      log.warn({ msg: 'Job already COMPLETED — skipping (idempotency guard)' });
      await this.messageQueue.deleteMessage(raw.receiptHandle);
      return;
    }

    // ─── Step 4: ジョブレコード初期化 ────────────────────────────────────────
    const job = SummarizationMessageMapper.toJob(input, raw.messageId);
    await this.jobRepository.save(job);

    try {
      // ─── Step 5: PDF ダウンロード → S3 保存 ─────────────────────────────────
      log.info({ msg: 'Downloading PDF', pdfUrl: job.pdfUrl });
      job.startDownloadingPdf();
      await this.jobRepository.save(job);

      const pdfS3Key = await this.pdfRepository.downloadAndSave(job.jobId, job.pdfUrl);
      job.completePdfDownload(pdfS3Key);
      await this.jobRepository.save(job);

      // ─── Step 6: Bedrock で要約 ──────────────────────────────────────────────
      log.info({ msg: 'Summarizing PDF with Bedrock', tone: job.tone, length: job.length });
      const pdfContent = await this.pdfRepository.getContent(pdfS3Key);
      const summaryText = await this.summarizer.summarize(pdfContent, job.tone, job.length);
      job.completeSummarizing(summaryText);
      await this.jobRepository.save(job);

      // ─── Step 7: Bedrock で SSML 変換 ───────────────────────────────────────
      log.info({ msg: 'Converting summary to SSML with Bedrock' });
      const ssmlText = await this.ssmlConverter.convert(summaryText);
      job.completeSsmlConversion(ssmlText);
      await this.jobRepository.save(job);

      // ─── Step 8: Polly で音声合成 → S3 保存 ─────────────────────────────────
      log.info({ msg: 'Generating audio with Polly', speakerType: job.speakerType });
      const audioS3Key = await this.audioGenerator.generate(
        ssmlText,
        job.jobId,
        job.speakerType,
      );
      job.complete(audioS3Key);
      await this.jobRepository.save(job);

      // ─── Step 9: 成功通知 ────────────────────────────────────────────────────
      log.info({ msg: 'Sending success notification', email: job.notificationEmail });
      await this.notification.sendSuccess(job.notificationEmail, job.jobId, audioS3Key);

      // ─── Step 10: SQS メッセージ削除 ─────────────────────────────────────────
      await this.messageQueue.deleteMessage(raw.receiptHandle);

      log.info({ msg: 'Job completed successfully' });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log.error({
        msg: 'Job failed',
        error: errorMessage,
        stack: err instanceof Error ? err.stack : undefined,
      });

      // DynamoDB にエラー状態を記録
      job.fail(errorMessage);
      await this.jobRepository.save(job).catch(
        (e) => log.error({ msg: 'Failed to update job status to FAILED', error: String(e) }),
      );

      // 失敗通知（失敗しても続行）
      await this.notification.sendFailure(job.notificationEmail, job.jobId, errorMessage).catch(
        (e) => log.error({ msg: 'Failed to send failure notification', error: String(e) }),
      );

      // メッセージは削除しない → maxReceiveCount 到達後に自動的に DLQ へ移動
      throw err;
    }
  }
}
