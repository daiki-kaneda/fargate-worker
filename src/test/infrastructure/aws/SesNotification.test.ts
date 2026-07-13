import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SesNotification } from '../../../infrastructure/aws/SesNotification';
import { Logger } from '../../../shared/logger/Logger';

jest.mock('@aws-sdk/client-ses');
jest.mock('@aws-sdk/client-s3');
jest.mock('@aws-sdk/s3-request-presigner');

const mockLogger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as unknown as Logger;

const PRESIGNED_URL = 'https://s3.example.com/audio.mp3?X-Amz-Signature=abc';

describe('SesNotification', () => {
  let mockSesSend: jest.Mock;
  let notification: SesNotification;

  beforeEach(() => {
    mockSesSend = jest.fn().mockResolvedValue({});
    (SESClient as jest.Mock).mockImplementation(() => ({ send: mockSesSend }));
    (S3Client as jest.Mock).mockImplementation(() => ({}));
    (getSignedUrl as jest.Mock).mockResolvedValue(PRESIGNED_URL);

    notification = new SesNotification(
      'sender@example.com',
      'audio-bucket',
      604800, // 7 days
      mockLogger,
    );
  });

  describe('sendSuccess', () => {
    test('sends email via SES with presigned URL and correct subject', async () => {
      await notification.sendSuccess('recipient@example.com', 'job-123', 'audio/job-123.mp3');

      expect(mockSesSend).toHaveBeenCalledTimes(1);
      // AWS SDK v3: constructor args are the input — check mock constructor call
      const constructorArg = (SendEmailCommand as unknown as jest.Mock).mock.calls[0][0] as {
        Source: string;
        Destination: { ToAddresses: string[] };
        Message: { Subject: { Data: string }; Body: { Text: { Data: string } } };
      };

      expect(constructorArg.Source).toBe('sender@example.com');
      expect(constructorArg.Destination.ToAddresses).toEqual(['recipient@example.com']);
      expect(constructorArg.Message.Subject.Data).toContain('job-123');
      expect(constructorArg.Message.Subject.Data).toContain('completed');
      expect(constructorArg.Message.Body.Text.Data).toContain(PRESIGNED_URL);
      expect(constructorArg.Message.Body.Text.Data).toContain('7 days');
    });

    test('generates presigned URL with correct bucket and key', async () => {
      await notification.sendSuccess('recipient@example.com', 'job-123', 'audio/job-123.mp3');

      // GetObjectCommand constructor args contain Bucket and Key
      const { GetObjectCommand } = jest.requireMock('@aws-sdk/client-s3') as {
        GetObjectCommand: jest.Mock;
      };
      const getObjectArg = GetObjectCommand.mock.calls[0][0] as {
        Bucket: string;
        Key: string;
      };
      expect(getObjectArg.Bucket).toBe('audio-bucket');
      expect(getObjectArg.Key).toBe('audio/job-123.mp3');
      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 604800 },
      );
    });

    test('throws when SES send fails', async () => {
      mockSesSend.mockRejectedValue(new Error('MessageRejected'));

      await expect(
        notification.sendSuccess('recipient@example.com', 'job-123', 'audio/job-123.mp3'),
      ).rejects.toThrow('MessageRejected');
    });

    test('throws when presigned URL generation fails', async () => {
      (getSignedUrl as jest.Mock).mockRejectedValue(new Error('NoSuchKey'));

      await expect(
        notification.sendSuccess('recipient@example.com', 'job-123', 'audio/job-123.mp3'),
      ).rejects.toThrow('NoSuchKey');
    });
  });

  describe('sendFailure', () => {
    test('sends failure email with error message and correct subject', async () => {
      await notification.sendFailure('recipient@example.com', 'job-456', 'PDF download failed');

      expect(mockSesSend).toHaveBeenCalledTimes(1);
      const constructorArg = (SendEmailCommand as unknown as jest.Mock).mock.calls[0][0] as {
        Source: string;
        Destination: { ToAddresses: string[] };
        Message: { Subject: { Data: string }; Body: { Text: { Data: string } } };
      };

      expect(constructorArg.Source).toBe('sender@example.com');
      expect(constructorArg.Destination.ToAddresses).toEqual(['recipient@example.com']);
      expect(constructorArg.Message.Subject.Data).toContain('job-456');
      expect(constructorArg.Message.Subject.Data).toContain('failed');
      expect(constructorArg.Message.Body.Text.Data).toContain('PDF download failed');
    });

    test('does not call getSignedUrl for failure notifications', async () => {
      await notification.sendFailure('recipient@example.com', 'job-456', 'some error');

      expect(getSignedUrl).not.toHaveBeenCalled();
    });

    test('throws when SES send fails', async () => {
      mockSesSend.mockRejectedValue(new Error('AccountSendingPaused'));

      await expect(
        notification.sendFailure('recipient@example.com', 'job-456', 'error'),
      ).rejects.toThrow('AccountSendingPaused');
    });
  });
});
