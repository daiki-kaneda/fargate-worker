export interface QueueMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
}

export interface MessageQueuePort {
  /** Long polling でメッセージを最大 maxMessages 件取得する。 */
  receiveMessages(maxMessages?: number): Promise<QueueMessage[]>;
  /** 処理完了したメッセージをキューから削除する。 */
  deleteMessage(receiptHandle: string): Promise<void>;
  /** Visibility timeout を延長する（長時間処理中の再配送防止）。 */
  changeVisibilityTimeout(receiptHandle: string, seconds: number): Promise<void>;
}
