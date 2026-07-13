import { Job } from '../entities/Job';

export interface JobRepositoryPort {
  /** ジョブレコードを新規作成または上書き保存する（upsert）。 */
  save(job: Job): Promise<void>;
  /** SQS MessageId で検索する（冪等性チェック用）。 */
  findByMessageId(messageId: string): Promise<Job | null>;
}
