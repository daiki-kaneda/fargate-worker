export interface AudioGeneratorPort {
  /**
   * SSML テキストを音声合成して S3 に保存し、S3 キーを返す。
   * 実装: Amazon Polly SynthesizeSpeech を使用。
   */
  generate(ssml: string, jobId: string, voiceId: string): Promise<string>;
}
