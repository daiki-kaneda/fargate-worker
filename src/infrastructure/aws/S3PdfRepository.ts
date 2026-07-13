import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import { PdfRepositoryPort } from '../../domain/ports/PdfRepositoryPort';
import { Logger } from '../../shared/logger/Logger';

export class S3PdfRepository implements PdfRepositoryPort {
  private readonly client: S3Client;

  constructor(
    private readonly bucketName: string,
    private readonly logger: Logger,
  ) {
    this.client = new S3Client({});
  }

  async downloadAndSave(jobId: string, pdfUrl: string): Promise<string> {
    this.logger.debug({ msg: 'Downloading PDF', pdfUrl });

    const response = await axios.get<ArrayBuffer>(pdfUrl, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: 50 * 1024 * 1024, // 50 MB 上限
    });

    const buffer = Buffer.from(response.data);
    const s3Key = `pdfs/${jobId}/source.pdf`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
        Body: buffer,
        ContentType: 'application/pdf',
      }),
    );

    this.logger.debug({ msg: 'PDF saved to S3', s3Key, sizeBytes: buffer.length });
    return s3Key;
  }

  async getContent(s3Key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      }),
    );

    if (!response.Body) throw new Error(`S3 object body is empty: ${s3Key}`);

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
