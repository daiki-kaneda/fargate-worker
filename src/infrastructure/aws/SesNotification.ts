import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NotificationPort } from '../../domain/ports/NotificationPort';
import { Logger } from '../../shared/logger/Logger';

/**
 * Amazon SES を使用してジョブ完了・失敗をメール通知する。
 *
 * SNS のようなサブスクリプション確認フローが不要で、
 * ジョブごとの任意のメールアドレスへ即時に直接送信できる。
 *
 * 前提: senderEmailAddress は SES で検証済みのメールアドレスまたはドメインであること。
 * 本番環境では SES sandbox を解除して任意の受信者に送信できるようにすること。
 */
export class SesNotification implements NotificationPort {
  private readonly ses: SESClient;
  private readonly s3: S3Client;

  constructor(
    private readonly senderEmailAddress: string,
    private readonly audioBucketName: string,
    private readonly presignedUrlExpiresIn: number,
    private readonly logger: Logger,
  ) {
    this.ses = new SESClient({});
    this.s3 = new S3Client({});
  }

  async sendSuccess(email: string, jobId: string, audioS3Key: string): Promise<void> {
    const presignedUrl = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.audioBucketName, Key: audioS3Key }),
      { expiresIn: this.presignedUrlExpiresIn },
    );

    const expiryDays = Math.round(this.presignedUrlExpiresIn / 86400);
    const body = [
      `Your paper summarization job has completed successfully.`,
      ``,
      `Job ID: ${jobId}`,
      ``,
      `Download your audio summary (valid for ${expiryDays} days):`,
      presignedUrl,
    ].join('\n');

    await this.ses.send(
      new SendEmailCommand({
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: `[Paper Summarizer] Job ${jobId} completed`, Charset: 'UTF-8' },
          Body: { Text: { Data: body, Charset: 'UTF-8' } },
        },
        Source: this.senderEmailAddress,
      }),
    );

    this.logger.debug({ msg: 'Success notification sent via SES', jobId, email });
  }

  async sendFailure(email: string, jobId: string, errorMessage: string): Promise<void> {
    const body = [
      `Your paper summarization job has failed.`,
      ``,
      `Job ID: ${jobId}`,
      `Error: ${errorMessage}`,
      ``,
      `Please check the job status or contact support.`,
    ].join('\n');

    await this.ses.send(
      new SendEmailCommand({
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: `[Paper Summarizer] Job ${jobId} failed`, Charset: 'UTF-8' },
          Body: { Text: { Data: body, Charset: 'UTF-8' } },
        },
        Source: this.senderEmailAddress,
      }),
    );

    this.logger.debug({ msg: 'Failure notification sent via SES', jobId, email });
  }
}
