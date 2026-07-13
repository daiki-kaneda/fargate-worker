import { ProcessJobUseCase } from '../../../application/usecases/ProcessJobUseCase';
import { MessageQueuePort, QueueMessage } from '../../../domain/ports/MessageQueuePort';
import { PdfRepositoryPort } from '../../../domain/ports/PdfRepositoryPort';
import { JobRepositoryPort } from '../../../domain/ports/JobRepositoryPort';
import { SummarizerPort } from '../../../domain/ports/SummarizerPort';
import { SsmlConverterPort } from '../../../domain/ports/SsmlConverterPort';
import { AudioGeneratorPort } from '../../../domain/ports/AudioGeneratorPort';
import { NotificationPort } from '../../../domain/ports/NotificationPort';
import { Job } from '../../../domain/entities/Job';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// テストフィクスチャ
// ---------------------------------------------------------------------------

const VALID_MESSAGE_BODY = JSON.stringify({
  jobId: '550e8400-e29b-41d4-a716-446655440000',
  pdfUrl: 'https://example.com/paper.pdf',
  tone: 'formal',
  length: 'medium',
  speakerType: 'Takumi',
  notificationEmail: 'user@example.com',
});

const VALID_RAW_MESSAGE: QueueMessage = {
  messageId: 'msg-001',
  receiptHandle: 'receipt-001',
  body: VALID_MESSAGE_BODY,
};

// ---------------------------------------------------------------------------
// モックファクトリ
// ---------------------------------------------------------------------------

type MockPorts = {
  messageQueue: jest.Mocked<MessageQueuePort>;
  pdfRepository: jest.Mocked<PdfRepositoryPort>;
  jobRepository: jest.Mocked<JobRepositoryPort>;
  summarizer: jest.Mocked<SummarizerPort>;
  ssmlConverter: jest.Mocked<SsmlConverterPort>;
  audioGenerator: jest.Mocked<AudioGeneratorPort>;
  notification: jest.Mocked<NotificationPort>;
};

function makeLogger(): jest.Mocked<Logger> {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
  // child() は同じモックロガーを返す（子ロガーも同一のモックで検証可能）
  (logger.child as jest.Mock).mockReturnValue(logger);
  return logger;
}

function makePorts(): MockPorts {
  const messageQueue: jest.Mocked<MessageQueuePort> = {
    receiveMessages: jest.fn().mockResolvedValue([VALID_RAW_MESSAGE]),
    deleteMessage: jest.fn().mockResolvedValue(undefined),
    changeVisibilityTimeout: jest.fn().mockResolvedValue(undefined),
  };

  const pdfRepository: jest.Mocked<PdfRepositoryPort> = {
    downloadAndSave: jest.fn().mockResolvedValue('pdfs/job-id/paper.pdf'),
    getContent: jest.fn().mockResolvedValue(Buffer.from('pdf content')),
  };

  const jobRepository: jest.Mocked<JobRepositoryPort> = {
    save: jest.fn().mockResolvedValue(undefined),
    findByMessageId: jest.fn().mockResolvedValue(null),
  };

  const summarizer: jest.Mocked<SummarizerPort> = {
    summarize: jest.fn().mockResolvedValue('This paper discusses...'),
  };

  const ssmlConverter: jest.Mocked<SsmlConverterPort> = {
    convert: jest.fn().mockResolvedValue('<speak>This paper discusses...</speak>'),
  };

  const audioGenerator: jest.Mocked<AudioGeneratorPort> = {
    generate: jest.fn().mockResolvedValue('audio/job-id/output.mp3'),
  };

  const notification: jest.Mocked<NotificationPort> = {
    sendSuccess: jest.fn().mockResolvedValue(undefined),
    sendFailure: jest.fn().mockResolvedValue(undefined),
  };

  return { messageQueue, pdfRepository, jobRepository, summarizer, ssmlConverter, audioGenerator, notification };
}

function makeUseCase(
  ports: MockPorts,
  logger: jest.Mocked<Logger>,
): ProcessJobUseCase {
  return new ProcessJobUseCase(
    ports.messageQueue,
    ports.pdfRepository,
    ports.jobRepository,
    ports.summarizer,
    ports.ssmlConverter,
    ports.audioGenerator,
    ports.notification,
    logger,
  );
}

// ---------------------------------------------------------------------------
// テストスイート
// ---------------------------------------------------------------------------

describe('ProcessJobUseCase', () => {
  let ports: ReturnType<typeof makePorts>;
  let logger: jest.Mocked<Logger>;
  let useCase: ProcessJobUseCase;

  beforeEach(() => {
    ports = makePorts();
    logger = makeLogger();
    useCase = makeUseCase(ports, logger);
  });

  // ─── Step 1: SQS Long Polling ──────────────────────────────────────────────

  describe('メッセージが存在しない場合', () => {
    test('何もせずに早期リターンする', async () => {
      ports.messageQueue.receiveMessages.mockResolvedValue([]);

      await useCase.execute();

      expect(ports.jobRepository.save).not.toHaveBeenCalled();
      expect(ports.messageQueue.deleteMessage).not.toHaveBeenCalled();
    });
  });

  // ─── Step 2: メッセージのパース・バリデーション ──────────────────────────────

  describe('不正な JSON ボディのメッセージ', () => {
    test('メッセージを削除して捨て、処理を終了する', async () => {
      ports.messageQueue.receiveMessages.mockResolvedValue([{
        ...VALID_RAW_MESSAGE,
        body: 'not-valid-json{{{',
      }]);

      await useCase.execute();

      expect(ports.messageQueue.deleteMessage).toHaveBeenCalledWith(VALID_RAW_MESSAGE.receiptHandle);
      expect(ports.jobRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('Zod スキーマに違反するメッセージ', () => {
    test('メッセージを削除して捨て、処理を終了する', async () => {
      ports.messageQueue.receiveMessages.mockResolvedValue([{
        ...VALID_RAW_MESSAGE,
        body: JSON.stringify({ jobId: 'not-a-uuid', pdfUrl: 'invalid-url' }),
      }]);

      await useCase.execute();

      expect(ports.messageQueue.deleteMessage).toHaveBeenCalledWith(VALID_RAW_MESSAGE.receiptHandle);
      expect(ports.jobRepository.save).not.toHaveBeenCalled();
    });
  });

  // ─── Step 3: 冪等性チェック ────────────────────────────────────────────────

  describe('冪等性チェック', () => {
    test('既に COMPLETED なジョブは処理をスキップして SQS メッセージを削除する', async () => {
      const completedJob = Job.fromSnapshot({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        messageId: 'msg-001',
        status: 'COMPLETED',
        pdfUrl: 'https://example.com/paper.pdf',
        tone: 'formal',
        length: 'medium',
        speakerType: 'Takumi',
        notificationEmail: 'user@example.com',
        pdfS3Key: 'pdfs/job/paper.pdf',
        summaryText: 'summary',
        ssmlText: '<speak>summary</speak>',
        audioS3Key: 'audio/job/output.mp3',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
      });
      ports.jobRepository.findByMessageId.mockResolvedValue(completedJob);

      await useCase.execute();

      expect(ports.messageQueue.deleteMessage).toHaveBeenCalledWith(VALID_RAW_MESSAGE.receiptHandle);
      expect(ports.pdfRepository.downloadAndSave).not.toHaveBeenCalled();
      expect(ports.notification.sendSuccess).not.toHaveBeenCalled();
    });

    test('FAILED ジョブは再処理する（再試行シナリオ）', async () => {
      const failedJob = Job.fromSnapshot({
        jobId: '550e8400-e29b-41d4-a716-446655440000',
        messageId: 'msg-001',
        status: 'FAILED',
        pdfUrl: 'https://example.com/paper.pdf',
        tone: 'formal',
        length: 'medium',
        speakerType: 'Takumi',
        notificationEmail: 'user@example.com',
        errorMessage: 'previous failure',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
      });
      ports.jobRepository.findByMessageId.mockResolvedValue(failedJob);

      await useCase.execute();

      // 再試行するので PDF ダウンロードが呼ばれる
      expect(ports.pdfRepository.downloadAndSave).toHaveBeenCalled();
    });
  });

  // ─── Happy Path ────────────────────────────────────────────────────────────

  describe('正常系フロー', () => {
    test('全ステップが順番に実行され、SQS メッセージが削除される', async () => {
      await useCase.execute();

      // PDF ダウンロード → 要約 → SSML → 音声 → 通知 → SQS 削除
      expect(ports.pdfRepository.downloadAndSave).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
        'https://example.com/paper.pdf',
      );
      expect(ports.pdfRepository.getContent).toHaveBeenCalledWith('pdfs/job-id/paper.pdf');
      expect(ports.summarizer.summarize).toHaveBeenCalledWith(
        expect.any(Buffer),
        'formal',
        'medium',
      );
      expect(ports.ssmlConverter.convert).toHaveBeenCalledWith('This paper discusses...');
      expect(ports.audioGenerator.generate).toHaveBeenCalledWith(
        '<speak>This paper discusses...</speak>',
        '550e8400-e29b-41d4-a716-446655440000',
        'Takumi',
      );
      expect(ports.notification.sendSuccess).toHaveBeenCalledWith(
        'user@example.com',
        '550e8400-e29b-41d4-a716-446655440000',
        'audio/job-id/output.mp3',
      );
      expect(ports.messageQueue.deleteMessage).toHaveBeenCalledWith(VALID_RAW_MESSAGE.receiptHandle);
    });

    test('DynamoDB にジョブのステータスが段階的に保存される', async () => {
      // Job はミュータブルな参照なので、save() 呼び出し時点のステータスをキャプチャする
      const capturedStatuses: string[] = [];
      ports.jobRepository.save.mockImplementation(async (job: Job) => {
        capturedStatuses.push(job.status);
      });

      await useCase.execute();

      expect(capturedStatuses).toEqual([
        'RECEIVED',
        'DOWNLOADING_PDF',
        'SUMMARIZING',
        'CONVERTING_SSML',
        'GENERATING_AUDIO',
        'COMPLETED',
      ]);
    });

    test('失敗通知は送信されない', async () => {
      await useCase.execute();

      expect(ports.notification.sendFailure).not.toHaveBeenCalled();
    });
  });

  // ─── エラーハンドリング ────────────────────────────────────────────────────

  describe('PDF ダウンロード失敗', () => {
    const downloadError = new Error('S3 connection timeout');

    beforeEach(() => {
      ports.pdfRepository.downloadAndSave.mockRejectedValue(downloadError);
    });

    test('ジョブを FAILED ステータスに更新する', async () => {
      await expect(useCase.execute()).rejects.toThrow(downloadError);

      const savedStatuses = ports.jobRepository.save.mock.calls.map(
        ([job]) => (job as Job).status,
      );
      expect(savedStatuses).toContain('FAILED');
    });

    test('失敗通知メールを送信する', async () => {
      await expect(useCase.execute()).rejects.toThrow(downloadError);

      expect(ports.notification.sendFailure).toHaveBeenCalledWith(
        'user@example.com',
        '550e8400-e29b-41d4-a716-446655440000',
        downloadError.message,
      );
    });

    test('SQS メッセージを削除しない（DLQ に委ねる）', async () => {
      await expect(useCase.execute()).rejects.toThrow(downloadError);

      expect(ports.messageQueue.deleteMessage).not.toHaveBeenCalled();
    });
  });

  describe('Bedrock 要約失敗', () => {
    const summarizeError = new Error('Bedrock throttling');

    beforeEach(() => {
      ports.summarizer.summarize.mockRejectedValue(summarizeError);
    });

    test('ジョブを FAILED ステータスに更新し、SQS メッセージを削除しない', async () => {
      await expect(useCase.execute()).rejects.toThrow(summarizeError);

      const savedStatuses = ports.jobRepository.save.mock.calls.map(
        ([job]) => (job as Job).status,
      );
      expect(savedStatuses).toContain('FAILED');
      expect(ports.messageQueue.deleteMessage).not.toHaveBeenCalled();
    });

    test('失敗通知メールを送信する', async () => {
      await expect(useCase.execute()).rejects.toThrow(summarizeError);

      expect(ports.notification.sendFailure).toHaveBeenCalledWith(
        'user@example.com',
        '550e8400-e29b-41d4-a716-446655440000',
        summarizeError.message,
      );
    });
  });

  describe('Polly 音声合成失敗', () => {
    const pollyError = new Error('Polly service unavailable');

    beforeEach(() => {
      ports.audioGenerator.generate.mockRejectedValue(pollyError);
    });

    test('ジョブを FAILED ステータスに更新し、SQS メッセージを削除しない', async () => {
      await expect(useCase.execute()).rejects.toThrow(pollyError);

      const savedStatuses = ports.jobRepository.save.mock.calls.map(
        ([job]) => (job as Job).status,
      );
      expect(savedStatuses).toContain('FAILED');
      expect(ports.messageQueue.deleteMessage).not.toHaveBeenCalled();
    });
  });

  describe('失敗通知メール自体が失敗した場合', () => {
    test('エラーをスローせず、元の処理エラーをそのまま再スローする', async () => {
      const originalError = new Error('PDF download failed');
      ports.pdfRepository.downloadAndSave.mockRejectedValue(originalError);
      ports.notification.sendFailure.mockRejectedValue(new Error('SES also failed'));

      await expect(useCase.execute()).rejects.toThrow(originalError);
    });
  });
});
