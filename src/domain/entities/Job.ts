export const TONES = ['casual', 'formal', 'academic'] as const;
export type Tone = (typeof TONES)[number];

export const SUMMARY_LENGTHS = ['short', 'medium', 'long'] as const;
export type SummaryLength = (typeof SUMMARY_LENGTHS)[number];

export type JobStatus =
  | 'RECEIVED'
  | 'DOWNLOADING_PDF'
  | 'SUMMARIZING'
  | 'CONVERTING_SSML'
  | 'GENERATING_AUDIO'
  | 'COMPLETED'
  | 'FAILED';

const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['COMPLETED', 'FAILED']);

/**
 * DynamoDB との永続化・再構築に使うプレーンオブジェクト表現。
 * partitionKey: jobId / GSI: messageId-index
 */
export interface JobSnapshot {
  jobId: string;
  messageId: string;
  status: JobStatus;
  pdfUrl: string;
  tone: Tone;
  length: SummaryLength;
  speakerType: string;
  notificationEmail: string;
  pdfS3Key?: string;
  summaryText?: string;
  ssmlText?: string;
  audioS3Key?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  /** Unix 秒タイムスタンプ。DynamoDB TTL 属性。作成日から 30 日後。 */
  ttl: number;
}

/** Job.create() に渡すパラメータ。ライフサイクル管理フィールドは Job 自身が設定する。 */
export type JobCreateParams = Omit<JobSnapshot,
  'status' | 'createdAt' | 'updatedAt' | 'ttl'
  | 'pdfS3Key' | 'summaryText' | 'ssmlText' | 'audioS3Key' | 'errorMessage'>;

export class InvalidJobTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid job transition: ${from} → ${to}`);
    this.name = 'InvalidJobTransitionError';
  }
}

/**
 * 論文要約ジョブを表すドメインエンティティ。
 *
 * 不正なステータス遷移は InvalidJobTransitionError をスローする。
 * 永続化には toSnapshot() を使い、復元には fromSnapshot() を使う。
 */
export class Job {
  private _status: JobStatus;
  private _updatedAt: string;
  private _pdfS3Key?: string;
  private _summaryText?: string;
  private _ssmlText?: string;
  private _audioS3Key?: string;
  private _errorMessage?: string;

  private constructor(private readonly base: Readonly<{
    jobId: string;
    messageId: string;
    pdfUrl: string;
    tone: Tone;
    length: SummaryLength;
    speakerType: string;
    notificationEmail: string;
    createdAt: string;
    ttl: number;
  }>, snapshot: JobSnapshot) {
    this._status = snapshot.status;
    this._updatedAt = snapshot.updatedAt;
    this._pdfS3Key = snapshot.pdfS3Key;
    this._summaryText = snapshot.summaryText;
    this._ssmlText = snapshot.ssmlText;
    this._audioS3Key = snapshot.audioS3Key;
    this._errorMessage = snapshot.errorMessage;
  }

  // ─── ファクトリ ────────────────────────────────────────────────────────────

  static create(params: JobCreateParams): Job {
    const now = new Date();
    const snapshot: JobSnapshot = {
      ...params,
      status: 'RECEIVED',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + 30 * 24 * 60 * 60,
    };
    return new Job({
      jobId: params.jobId,
      messageId: params.messageId,
      pdfUrl: params.pdfUrl,
      tone: params.tone,
      length: params.length,
      speakerType: params.speakerType,
      notificationEmail: params.notificationEmail,
      createdAt: snapshot.createdAt,
      ttl: snapshot.ttl,
    }, snapshot);
  }

  static fromSnapshot(snapshot: JobSnapshot): Job {
    return new Job({
      jobId: snapshot.jobId,
      messageId: snapshot.messageId,
      pdfUrl: snapshot.pdfUrl,
      tone: snapshot.tone,
      length: snapshot.length,
      speakerType: snapshot.speakerType,
      notificationEmail: snapshot.notificationEmail,
      createdAt: snapshot.createdAt,
      ttl: snapshot.ttl,
    }, snapshot);
  }

  // ─── ゲッター ──────────────────────────────────────────────────────────────

  get jobId(): string { return this.base.jobId; }
  get messageId(): string { return this.base.messageId; }
  get status(): JobStatus { return this._status; }
  get pdfUrl(): string { return this.base.pdfUrl; }
  get tone(): Tone { return this.base.tone; }
  get length(): SummaryLength { return this.base.length; }
  get speakerType(): string { return this.base.speakerType; }
  get notificationEmail(): string { return this.base.notificationEmail; }
  get pdfS3Key(): string | undefined { return this._pdfS3Key; }
  get summaryText(): string | undefined { return this._summaryText; }
  get ssmlText(): string | undefined { return this._ssmlText; }
  get audioS3Key(): string | undefined { return this._audioS3Key; }
  get errorMessage(): string | undefined { return this._errorMessage; }
  get createdAt(): string { return this.base.createdAt; }
  get updatedAt(): string { return this._updatedAt; }
  get ttl(): number { return this.base.ttl; }

  // ─── ドメインクエリ ────────────────────────────────────────────────────────

  isCompleted(): boolean { return this._status === 'COMPLETED'; }
  isFailed(): boolean { return this._status === 'FAILED'; }
  isTerminal(): boolean { return TERMINAL_STATUSES.has(this._status); }

  // ─── ステータス遷移メソッド ────────────────────────────────────────────────

  startDownloadingPdf(): void {
    this.assertStatus('RECEIVED', 'DOWNLOADING_PDF');
    this.transition('DOWNLOADING_PDF');
  }

  completePdfDownload(pdfS3Key: string): void {
    this.assertStatus('DOWNLOADING_PDF', 'SUMMARIZING');
    this._pdfS3Key = pdfS3Key;
    this.transition('SUMMARIZING');
  }

  completeSummarizing(summaryText: string): void {
    this.assertStatus('SUMMARIZING', 'CONVERTING_SSML');
    this._summaryText = summaryText;
    this.transition('CONVERTING_SSML');
  }

  completeSsmlConversion(ssmlText: string): void {
    this.assertStatus('CONVERTING_SSML', 'GENERATING_AUDIO');
    this._ssmlText = ssmlText;
    this.transition('GENERATING_AUDIO');
  }

  complete(audioS3Key: string): void {
    this.assertStatus('GENERATING_AUDIO', 'COMPLETED');
    this._audioS3Key = audioS3Key;
    this.transition('COMPLETED');
  }

  fail(errorMessage: string): void {
    if (this.isTerminal()) {
      throw new InvalidJobTransitionError(this._status, 'FAILED');
    }
    this._errorMessage = errorMessage;
    this.transition('FAILED');
  }

  // ─── 永続化用 ──────────────────────────────────────────────────────────────

  toSnapshot(): JobSnapshot {
    return {
      jobId: this.base.jobId,
      messageId: this.base.messageId,
      status: this._status,
      pdfUrl: this.base.pdfUrl,
      tone: this.base.tone,
      length: this.base.length,
      speakerType: this.base.speakerType,
      notificationEmail: this.base.notificationEmail,
      pdfS3Key: this._pdfS3Key,
      summaryText: this._summaryText,
      ssmlText: this._ssmlText,
      audioS3Key: this._audioS3Key,
      errorMessage: this._errorMessage,
      createdAt: this.base.createdAt,
      updatedAt: this._updatedAt,
      ttl: this.base.ttl,
    };
  }

  // ─── プライベートヘルパー ──────────────────────────────────────────────────

  private transition(to: JobStatus): void {
    this._status = to;
    this._updatedAt = new Date().toISOString();
  }

  private assertStatus(expected: JobStatus, next: JobStatus): void {
    if (this._status !== expected) {
      throw new InvalidJobTransitionError(this._status, next);
    }
  }
}
