import { Tone, SummaryLength } from '../entities/Job';

export interface SummarizerPort {
  /**
   * PDF バイナリを受け取り、指定トーン・長さで要約テキストを返す。
   * 実装: Bedrock (Claude 3.5) の PDF document ブロックを使用。
   */
  summarize(pdfContent: Buffer, tone: Tone, length: SummaryLength): Promise<string>;
}
