export interface Config {
  queueUrl: string;
  pdfBucketName: string;
  audioBucketName: string;
  jobTableName: string;
  /** SES で検証済みの送信元メールアドレス。 */
  senderEmailAddress: string;
  awsRegion: string;
  logLevel: string;
  /** 音声ファイル署名付き URL の有効期間（秒）。デフォルト 7 日。 */
  presignedUrlExpiresIn: number;
  /**
   * Bedrock 推論プロファイル ID。
   * AP リージョン向けクロスリージョン推論: ap.anthropic.claude-3-5-sonnet-20241022-v2:0
   */
  bedrockModelId: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function createConfig(): Config {
  return {
    queueUrl: required('QUEUE_URL'),
    pdfBucketName: required('PDF_BUCKET_NAME'),
    audioBucketName: required('AUDIO_BUCKET_NAME'),
    jobTableName: required('JOB_TABLE_NAME'),
    senderEmailAddress: required('SENDER_EMAIL_ADDRESS'),
    awsRegion: process.env['AWS_DEFAULT_REGION'] ?? 'ap-northeast-1',
    logLevel: process.env['LOG_LEVEL'] ?? 'INFO',
    presignedUrlExpiresIn: Number(process.env['PRESIGNED_URL_EXPIRES_IN'] ?? 604800),
    bedrockModelId:
      process.env['BEDROCK_MODEL_ID'] ?? 'ap.anthropic.claude-3-5-sonnet-20241022-v2:0',
  };
}
