import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
} from '@aws-sdk/client-sqs';
import { SqsMessageQueue } from '../../../infrastructure/aws/SqsMessageQueue';
import { Logger } from '../../../shared/logger/Logger';

jest.mock('@aws-sdk/client-sqs');

const mockLogger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as unknown as Logger;

const QUEUE_URL = 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/test-queue';

describe('SqsMessageQueue', () => {
  let mockSend: jest.Mock;
  let queue: SqsMessageQueue;

  beforeEach(() => {
    mockSend = jest.fn();
    (SQSClient as jest.Mock).mockImplementation(() => ({ send: mockSend }));
    queue = new SqsMessageQueue(QUEUE_URL, mockLogger);
  });

  describe('receiveMessages', () => {
    test('returns mapped QueueMessage array when SQS has messages', async () => {
      mockSend.mockResolvedValue({
        Messages: [
          { MessageId: 'msg-1', ReceiptHandle: 'handle-1', Body: '{"jobId":"job-1"}' },
          { MessageId: 'msg-2', ReceiptHandle: 'handle-2', Body: '{"jobId":"job-2"}' },
        ],
      });

      const messages = await queue.receiveMessages(2);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ messageId: 'msg-1', receiptHandle: 'handle-1', body: '{"jobId":"job-1"}' });
      expect(messages[1]).toEqual({ messageId: 'msg-2', receiptHandle: 'handle-2', body: '{"jobId":"job-2"}' });
    });

    test('returns empty array when no messages are available', async () => {
      mockSend.mockResolvedValue({ Messages: [] });

      const messages = await queue.receiveMessages();
      expect(messages).toHaveLength(0);
    });

    test('returns empty array when SQS response has no Messages field', async () => {
      mockSend.mockResolvedValue({});

      const messages = await queue.receiveMessages();
      expect(messages).toHaveLength(0);
    });

    test('filters out messages missing MessageId, ReceiptHandle, or Body', async () => {
      mockSend.mockResolvedValue({
        Messages: [
          { MessageId: 'msg-1', ReceiptHandle: 'handle-1', Body: 'valid' },
          { MessageId: undefined, ReceiptHandle: 'handle-2', Body: 'missing-id' },
          { MessageId: 'msg-3', ReceiptHandle: undefined, Body: 'missing-handle' },
          { MessageId: 'msg-4', ReceiptHandle: 'handle-4', Body: undefined },
        ],
      });

      const messages = await queue.receiveMessages(4);
      expect(messages).toHaveLength(1);
      expect(messages[0].messageId).toBe('msg-1');
    });

    test('sends ReceiveMessageCommand with long polling (WaitTimeSeconds=20)', async () => {
      mockSend.mockResolvedValue({ Messages: [] });

      await queue.receiveMessages(1);

      expect(mockSend).toHaveBeenCalledTimes(1);
      // AWS SDK v3: constructor args are the input — check mock constructor call
      const constructorArg = (ReceiveMessageCommand as unknown as jest.Mock).mock.calls[0][0] as {
        QueueUrl: string;
        WaitTimeSeconds: number;
        MaxNumberOfMessages: number;
      };
      expect(constructorArg.QueueUrl).toBe(QUEUE_URL);
      expect(constructorArg.WaitTimeSeconds).toBe(20);
      expect(constructorArg.MaxNumberOfMessages).toBe(1);
    });

    test('propagates SDK errors', async () => {
      mockSend.mockRejectedValue(new Error('QueueDoesNotExist'));

      await expect(queue.receiveMessages()).rejects.toThrow('QueueDoesNotExist');
    });
  });

  describe('deleteMessage', () => {
    test('sends DeleteMessageCommand with correct queue URL and receipt handle', async () => {
      mockSend.mockResolvedValue({});

      await queue.deleteMessage('receipt-handle-abc');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const constructorArg = (DeleteMessageCommand as unknown as jest.Mock).mock.calls[0][0] as {
        QueueUrl: string;
        ReceiptHandle: string;
      };
      expect(constructorArg.QueueUrl).toBe(QUEUE_URL);
      expect(constructorArg.ReceiptHandle).toBe('receipt-handle-abc');
    });

    test('propagates SDK errors', async () => {
      mockSend.mockRejectedValue(new Error('ReceiptHandleIsInvalid'));

      await expect(queue.deleteMessage('bad-handle')).rejects.toThrow('ReceiptHandleIsInvalid');
    });
  });

  describe('changeVisibilityTimeout', () => {
    test('sends ChangeMessageVisibilityCommand with correct parameters', async () => {
      mockSend.mockResolvedValue({});

      await queue.changeVisibilityTimeout('receipt-handle-xyz', 300);

      expect(mockSend).toHaveBeenCalledTimes(1);
      const constructorArg = (ChangeMessageVisibilityCommand as unknown as jest.Mock).mock.calls[0][0] as {
        QueueUrl: string;
        ReceiptHandle: string;
        VisibilityTimeout: number;
      };
      expect(constructorArg.QueueUrl).toBe(QUEUE_URL);
      expect(constructorArg.ReceiptHandle).toBe('receipt-handle-xyz');
      expect(constructorArg.VisibilityTimeout).toBe(300);
    });

    test('propagates SDK errors', async () => {
      mockSend.mockRejectedValue(new Error('InvalidParameterValue'));

      await expect(queue.changeVisibilityTimeout('handle', -1)).rejects.toThrow('InvalidParameterValue');
    });
  });
});
