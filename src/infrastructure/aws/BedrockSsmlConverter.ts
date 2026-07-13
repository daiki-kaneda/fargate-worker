import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SsmlConverterPort } from '../../domain/ports/SsmlConverterPort';
import { Logger } from '../../shared/logger/Logger';

const SYSTEM_PROMPT = `You are an SSML markup expert. Convert the provided text into Amazon Polly-compatible SSML.

Rules:
- Wrap the entire output in <speak> tags.
- Add <break time="500ms"/> between paragraphs.
- Use <emphasis level="moderate"> for key terms.
- Add <prosody rate="slow"> around complex sentences.
- Do NOT include markdown, code fences, or any text outside the <speak>...</speak> block.
- Keep all original content — do not summarize or omit anything.`;

export class BedrockSsmlConverter implements SsmlConverterPort {
  private readonly client: BedrockRuntimeClient;

  constructor(
    private readonly modelId: string,
    private readonly logger: Logger,
  ) {
    this.client = new BedrockRuntimeClient({});
  }

  async convert(text: string): Promise<string> {
    const requestBody = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: text,
        },
      ],
    };

    this.logger.debug({ msg: 'Invoking Bedrock for SSML conversion', modelId: this.modelId });

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

    const ssml = responseBody.content.find((c) => c.type === 'text')?.text;
    if (!ssml) throw new Error('Bedrock SSML conversion returned empty response');
    if (!ssml.includes('<speak>')) throw new Error('Bedrock SSML output is missing <speak> tag');

    this.logger.debug({ msg: 'SSML conversion completed', outputLength: ssml.length });
    return ssml;
  }
}
