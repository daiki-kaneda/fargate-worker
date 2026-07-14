import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { BedrockSsmlConverter } from '../../../infrastructure/aws/BedrockSsmlConverter';
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

describe('BedrockSsmlConverter', () => {
  let mockSend: jest.Mock;
  let converter: BedrockSsmlConverter;

  beforeEach(() => {
    mockSend = jest.fn();
    (BedrockRuntimeClient as jest.Mock).mockImplementation(() => ({ send: mockSend }));
    converter = new BedrockSsmlConverter('test-model-id', mockLogger);
  });

  test('convert returns SSML string from Bedrock response', async () => {
    const ssml = '<speak>Hello <break time="500ms"/> world.</speak>';
    mockSend.mockResolvedValue({ body: makeResponseBody(ssml) });

    const result = await converter.convert('Hello world.');

    expect(result).toBe(ssml);
  });

  test('convert sends InvokeModelCommand with correct modelId and input text', async () => {
    const ssml = '<speak>text</speak>';
    mockSend.mockResolvedValue({ body: makeResponseBody(ssml) });

    await converter.convert('input text');

    expect(mockSend).toHaveBeenCalledTimes(1);

    // AWS SDK v3: constructor args are the input — check mock constructor call
    const constructorArg = (InvokeModelCommand as unknown as jest.Mock).mock.calls[0][0] as {
      modelId: string;
      body: string;
    };
    expect(constructorArg.modelId).toBe('test-model-id');

    const body = JSON.parse(constructorArg.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0].content).toBe('input text');
  });

  test('convert throws when response does not contain a text block', async () => {
    mockSend.mockResolvedValue({
      body: new TextEncoder().encode(JSON.stringify({ content: [] })),
    });

    await expect(converter.convert('text')).rejects.toThrow(
      'Bedrock SSML conversion returned empty response',
    );
  });

  test('convert strips markdown code fences from Bedrock response', async () => {
    const wrapped = '```xml\n<speak>Hello world.</speak>\n```';
    mockSend.mockResolvedValue({ body: makeResponseBody(wrapped) });

    const result = await converter.convert('Hello world.');

    expect(result).toBe('<speak>Hello world.</speak>');
  });

  test('convert throws when output is missing <speak> tag', async () => {
    const invalidSsml = 'Hello world without speak tags';
    mockSend.mockResolvedValue({ body: makeResponseBody(invalidSsml) });

    await expect(converter.convert('text')).rejects.toThrow(
      'Bedrock SSML output is missing <speak> tag',
    );
  });

  test('convert propagates SDK errors', async () => {
    mockSend.mockRejectedValue(new Error('ServiceUnavailableException'));

    await expect(converter.convert('text')).rejects.toThrow('ServiceUnavailableException');
  });
});
