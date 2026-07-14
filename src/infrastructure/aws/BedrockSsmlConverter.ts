import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SsmlConverterPort } from '../../domain/ports/SsmlConverterPort';
import { Logger } from '../../shared/logger/Logger';

const SYSTEM_PROMPT = `You are an expert in converting summary text into the optimal SSML (Speech Synthesis Markup Language) format for the Amazon Polly "Neural" engine.
Your goal is to transform the provided summary text into high-quality, natural-sounding SSML that mimics a professional podcast or narration.

Strictly adhere to the following [SSML Generation Rules].

[SSML Generation Rules]
1. ALLOWED TAGS ONLY:
   You must ONLY use the following tags. Do NOT use any other tags (such as <emphasis>, <prosody>, or <amazon:effect>), as they are either unsupported by the Neural engine or may degrade the natural flow of the AI-generated voice.
   - <speak> (The root element)
   - <p> (Paragraphs)
   - <s> (Individual sentences)
   - <break time="..." /> (For pauses, using "ms" or "s")
   - <say-as interpret-as="..."> (For specifying how to read abbreviations, numbers, etc.)

2. NATURAL PAUSING (The <break> tag):
   Insert appropriate <break> tags to establish a comfortable, human-like rhythm. Use the following guidelines:
   - After a major title or section header: <break time="1.2s" /> or <break time="1.5s" />
   - Between paragraphs (<p>): <break time="1.0s" />
   - Between list items / bullet points: <break time="800ms" />
   - Between sentences (<s>) where a brief transition in thought occurs: <break time="500ms" />

3. TEXT CLEANING & FORMATTING:
   - Remove all markdown formatting syntax (such as "#", "*", "-", or "1.") and convert them into natural spoken phrases.
   - Preserve the full meaning of the summary — do not omit sections, but rewrite markdown into speakable prose.
   - Example: "- LLaMA-13B: outperforms GPT-3"
     -> "<s>First, the LLaMA thirteen B model outperforms G P T three.</s>"
   - Prefer spelling out abbreviations naturally (e.g. "G P T three") over <say-as> when it sounds more natural.
   - Use <say-as interpret-as="characters"> only when letter-by-letter pronunciation is clearly needed.
   - Escape XML special characters in text content (& → &amp;, < → &lt;, > → &gt;).

4. LENGTH:
   Keep the total SSML output under 5,500 characters. Amazon Polly SynthesizeSpeech has a 6,000-character input limit.

5. RESPONSE FORMAT:
   Return ONLY the valid, well-formed SSML document starting with <speak> and ending with </speak>. Do NOT include any conversational filler, explanations, or markdown code blocks (e.g., do not wrap the output in \`\`\`xml).`;

/** Bedrock が markdown フェンス付きで返した場合に Polly 向け SSML だけを取り出す。 */
function extractSsml(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```(?:xml)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const match = text.match(/<speak>[\s\S]*<\/speak>/i);
  return (match ? match[0] : text).trim();
}

/** Polly Neural 非対応タグを除去し、内側のテキストだけを残す（モデルがルール違反した場合の保険）。 */
function stripForbiddenNeuralTags(ssml: string): string {
  const forbidden = ['emphasis', 'prosody', 'amazon:effect'];
  let result = ssml;
  for (const tag of forbidden) {
    result = result.replace(new RegExp(`<${tag}[^>]*>`, 'gi'), '');
    result = result.replace(new RegExp(`</${tag}>`, 'gi'), '');
  }
  return result;
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

    const ssml = stripForbiddenNeuralTags(extractSsml(raw));
    if (!ssml.startsWith('<speak>') || !ssml.endsWith('</speak>')) {
      throw new Error('Bedrock SSML output is missing <speak> tag');
    }

    this.logger.debug({ msg: 'SSML conversion completed', outputLength: ssml.length });
    return ssml;
  }
}
