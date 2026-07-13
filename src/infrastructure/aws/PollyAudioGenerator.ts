import {
  PollyClient,
  SynthesizeSpeechCommand,
  LanguageCode,
  VoiceId,
  Engine,
} from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { AudioGeneratorPort } from '../../domain/ports/AudioGeneratorPort';
import { Logger } from '../../shared/logger/Logger';

/** Polly Neural エンジン対応の代表的な VoiceId → LanguageCode マッピング */
const VOICE_LANGUAGE_MAP: Partial<Record<string, LanguageCode>> = {
  Takumi: 'ja-JP',
  Kazuha: 'ja-JP',
  Tomoko: 'ja-JP',
  Joanna: 'en-US',
  Matthew: 'en-US',
  Amy: 'en-GB',
  Brian: 'en-GB',
  Aria: 'en-NZ',
};

export class PollyAudioGenerator implements AudioGeneratorPort {
  private readonly polly: PollyClient;
  private readonly s3: S3Client;

  constructor(
    private readonly audioBucketName: string,
    private readonly logger: Logger,
  ) {
    this.polly = new PollyClient({});
    this.s3 = new S3Client({});
  }

  async generate(ssml: string, jobId: string, voiceId: string): Promise<string> {
    const languageCode = VOICE_LANGUAGE_MAP[voiceId] ?? 'en-US';

    this.logger.debug({ msg: 'Synthesizing speech with Polly', voiceId, languageCode });

    const response = await this.polly.send(
      new SynthesizeSpeechCommand({
        Engine: 'neural' as Engine,
        OutputFormat: 'mp3',
        Text: ssml,
        TextType: 'ssml',
        VoiceId: voiceId as VoiceId,
        LanguageCode: languageCode,
      }),
    );

    if (!response.AudioStream) throw new Error('Polly returned empty audio stream');

    // AudioStream を Buffer に変換
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.AudioStream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const audioBuffer = Buffer.concat(chunks);

    const s3Key = `audio/${jobId}/output.mp3`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.audioBucketName,
        Key: s3Key,
        Body: audioBuffer,
        ContentType: 'audio/mpeg',
      }),
    );

    this.logger.debug({ msg: 'Audio saved to S3', s3Key, sizeBytes: audioBuffer.length });
    return s3Key;
  }
}
