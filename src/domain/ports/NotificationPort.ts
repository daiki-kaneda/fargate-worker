export interface NotificationPort {
  /**
   * 処理成功時に音声ファイルの署名付き URL をメールで通知する。
   * @param audioS3Key 音声ファイルの S3 キー
   */
  sendSuccess(email: string, jobId: string, audioS3Key: string): Promise<void>;
  /** 処理失敗時にエラー内容をメールで通知する。 */
  sendFailure(email: string, jobId: string, errorMessage: string): Promise<void>;
}
