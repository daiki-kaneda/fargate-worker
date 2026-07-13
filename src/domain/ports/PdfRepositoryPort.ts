export interface PdfRepositoryPort {
  /** URL から PDF をダウンロードして S3 に保存し、S3 キーを返す。 */
  downloadAndSave(jobId: string, pdfUrl: string): Promise<string>;
  /** S3 キーから PDF のバイナリを取得する。 */
  getContent(s3Key: string): Promise<Buffer>;
}
