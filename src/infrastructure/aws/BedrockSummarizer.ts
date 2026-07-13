import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SummarizerPort } from '../../domain/ports/SummarizerPort';
import { Tone, SummaryLength } from '../../domain/entities/Job';
import { Logger } from '../../shared/logger/Logger';

const WORD_TARGETS: Record<SummaryLength, number> = {
  short: 300,
  medium: 600,
  long: 1200,
};

const TONE_INSTRUCTIONS: Record<Tone, string> = {
  casual: 'Use friendly, conversational language that is easy for a general audience to understand.',
  formal: 'Use professional and clear language suitable for a business or academic report.',
  academic:
    'Use precise technical language appropriate for readers familiar with the field.',
};

export class BedrockSummarizer implements SummarizerPort {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly modelId: string,
    private readonly logger: Logger,
  ) {
    this.client = new BedrockRuntimeClient({});
  }

  async summarize(pdfContent: Buffer, tone: Tone, length: SummaryLength): Promise<string> {
    const wordTarget = WORD_TARGETS[length];
    const toneInstruction = TONE_INSTRUCTIONS[tone];

    const prompt = `You are an expert science communicator. Summarize the following academic paper.

Requirements:
- Target length: approximately ${wordTarget} words.
- ${toneInstruction}
- Structure: brief introduction, key findings, methodology overview, conclusions.
- Write only the summary. Do not include meta-commentary or explanations about the task.`;

    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfContent.toString('base64'),
              },
            },
            {
              type: 'text',
              text: prompt,
            },
          ],
        },
      ],
    };

    this.logger.debug({ msg: 'Invoking Bedrock for summarization', modelId: this.modelId, tone, length });

    const response = await this.client.send(
      new InvokeModelCommand({
        modelId: this.modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(requestBody),
      }),
    );

    const responseBody = JSON.parse(new TextDecoder().decode(response.body)) as {
      content: Array<{ type: string; text: string }>;
    };

    const text = responseBody.content.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error('Bedrock summarization returned empty response');

    this.logger.debug({ msg: 'Summarization completed', outputLength: text.length });
    return text;
  }
}
