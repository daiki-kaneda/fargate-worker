import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockSummarizer } from '../../../infrastructure/aws/BedrockSummarizer';
import { Logger } from '../../../shared/logger/Logger';

jest.mock('@aws-sdk/client-bedrock-runtime');

const mockLogger: Logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
} as unknown as Logger;

function makeResponseBody(text: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ content: [{ type: 'text', text }] }),
  );
}

describe('BedrockSummarizer', () => {
  let mockSend: jest.Mock;
  let summarizer: BedrockSummarizer;

  beforeEach(() => {
    mockSend = jest.fn();
    (BedrockRuntimeClient as jest.Mock).mockImplementation(() => ({ send: mockSend }));
    summarizer = new BedrockSummarizer('test-model-id', mockLogger);
  });

  test('summarize calls InvokeModelCommand with correct modelId and PDF as base64 document', async () => {
    const summaryText = 'This is a summary.';
    mockSend.mockResolvedValue({ body: makeResponseBody(summaryText) });

    const pdfBuffer = Buffer.from('fake-pdf-content');
    const result = await summarizer.summarize(pdfBuffer, 'casual', 'short');

    expect(result).toBe(summaryText);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // AWS SDK v3: constructor args are the input — check mock constructor call
    const constructorArg = (InvokeModelCommand as unknown as jest.Mock).mock.calls[0][0] as {
      modelId: string;
      body: string;
    };
    expect(constructorArg.modelId).toBe('test-model-id');

    const body = JSON.parse(constructorArg.body) as {
      messages: Array<{ content: Array<{ type: string; source?: { data: string } }> }>;
    };
    const documentBlock = body.messages[0].content.find((c) => c.type === 'document');
    expect(documentBlock?.source?.data).toBe(pdfBuffer.toString('base64'));
  });

  test('summarize includes tone instruction in the prompt', async () => {
    mockSend.mockResolvedValue({ body: makeResponseBody('summary') });

    await summarizer.summarize(Buffer.from('pdf'), 'academic', 'long');

    const constructorArg = (InvokeModelCommand as unknown as jest.Mock).mock.calls[0][0] as {
      body: string;
    };
    const body = JSON.parse(constructorArg.body) as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const textBlock = body.messages[0].content.find((c) => c.type === 'text');
    expect(textBlock?.text).toContain('1200'); // long = 1200 words
    expect(textBlock?.text).toContain('technical language'); // academic tone
  });

  test('summarize throws when Bedrock returns empty content array', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [] })),
    });

    await expect(summarizer.summarize(Buffer.from('pdf'), 'formal', 'medium')).rejects.toThrow(
      'Bedrock summarization returned empty response',
    );
  });

  test('summarize throws when Bedrock returns no text block', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({ content: [{ type: 'image', data: 'xyz' }] }),
      ),
    });

    await expect(summarizer.summarize(Buffer.from('pdf'), 'casual', 'short')).rejects.toThrow(
      'Bedrock summarization returned empty response',
    );
  });

  test('summarize propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('ThrottlingException'));

    await expect(summarizer.summarize(Buffer.from('pdf'), 'casual', 'short')).rejects.toThrow(
      'ThrottlingException',
    );
  });
});
