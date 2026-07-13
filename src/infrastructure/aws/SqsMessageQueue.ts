import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { MessageQueuePort, QueueMessage } from '../../domain/ports/MessageQueuePort';
import { Logger } from '../../shared/logger/Logger';

export class SqsMessageQueue implements MessageQueuePort {
  private readonly client: SQSClient;

  constructor(
    private readonly queueUrl: string,
    private readonly logger: Logger,
  ) {
    this.client = new SQSClient({});
  }

  async receiveMessages(maxMessages = 1): Promise<QueueMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: 20, // Long polling
      }),
    );

    const messages = response.Messages ?? [];
    this.logger.debug({ msg: 'SQS receive completed', count: messages.length });

    return messages
      .filter((m) => m.MessageId && m.ReceiptHandle && m.Body)
      .map((m) => ({
        messageId: m.MessageId!,
        receiptHandle: m.ReceiptHandle!,
        body: m.Body!,
      }));
  }

  async deleteMessage(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
    this.logger.debug({ msg: 'SQS message deleted' });
  }

  async changeVisibilityTimeout(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
    this.logger.debug({ msg: 'SQS visibility timeout changed', seconds });
  }
}
