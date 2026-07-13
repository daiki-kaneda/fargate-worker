import { z } from 'zod';
import { TONES, SUMMARY_LENGTHS } from '../../domain/entities/Job';

/**
 * SQS キューに送信されるメッセージの Zod スキーマ。
 * domain の TONES / SUMMARY_LENGTHS 定数を参照することで値の二重定義を避ける。
 */
export const SummarizationMessageSchema = z.object({
  /** クライアントが生成する UUID。冪等性チェックに使用する。 */
  jobId: z.uuid(),
  /** 要約する論文の PDF URL。 */
  pdfUrl: z.url(),
  /** 要約のトーン。 */
  tone: z.enum(TONES),
  /** 要約の長さ: short=300 語, medium=600 語, long=1200 語 */
  length: z.enum(SUMMARY_LENGTHS),
  /** Amazon Polly の Voice ID (例: 'Takumi', 'Joanna')。 */
  speakerType: z.string().min(1),
  /** 完了通知の送信先メールアドレス。 */
  notificationEmail: z.email(),
});

export type SummarizationMessageDto = z.infer<typeof SummarizationMessageSchema>;
