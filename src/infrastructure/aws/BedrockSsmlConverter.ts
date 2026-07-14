import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SsmlConverterPort } from '../../domain/ports/SsmlConverterPort';
import { Logger } from '../../shared/logger/Logger';

const SYSTEM_PROMPT = `You convert plain text into Amazon Polly-compatible SSML for the neural engine.

Output format (CRITICAL):
- Return ONLY raw SSML XML. Your entire response must start with <speak> and end with </speak>.
- Never wrap output in markdown code fences (no \`\`\`xml, no \`\`\`, no backticks).
- Never add explanations, prefixes, or suffixes before or after the SSML.

SSML rules:
- Wrap the entire output in a single <speak>...</speak> block.
- Add <break time="500ms"/> between paragraphs.
- Use <emphasis level="moderate"> for key terms.
- Use <prosody rate="slow"> around long or complex sentences.
- Escape XML special characters in text content (& → &amp;, < → &lt;, > → &gt;).
- Keep all original content — do not summarize or omit anything.

Example output:
<speak>Hello <break time="500ms"/> world.</speak>`;

/** Bedrock が markdown フェンス付きで返した場合に Polly 向け SSML だけを取り出す。 */
function extractSsml(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:xml)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const match = text.match(/<speak>[\s\S]*<\/speak>/i);
  return (match ? match[0] : text).trim();
}

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

    const raw = responseBody.content.find((c) => c.type === 'text')?.text;
    if (!raw) throw new Error('Bedrock SSML conversion returned empty response');

    const ssml = extractSsml(raw);
    if (!ssml.startsWith('<speak>') || !ssml.endsWith('</speak>')) {
      throw new Error('Bedrock SSML output is missing <speak> tag');
    }

    this.logger.debug({ msg: 'SSML conversion completed', outputLength: ssml.length });
    return ssml;
  }
}
