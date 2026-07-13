export interface SsmlConverterPort {
  /**
   * プレーンテキストを Amazon Polly に適した SSML 形式に変換する。
   * 実装: Bedrock (Claude 3.5) を使用。
   */
  convert(text: string): Promise<string>;
}
