import { SummarizationMessageDto } from '../dtos/SummarizationMessageDto';
import { Job } from '../../domain/entities/Job';

/**
 * SummarizationMessageDto を Job エンティティへ変換するマッパー。
 * DTO（application 層）と Job.create() パラメータ（domain 層）の橋渡しを担う。
 */
export class SummarizationMessageMapper {
  static toJob(dto: SummarizationMessageDto, messageId: string): Job {
    return Job.create({
      jobId: dto.jobId,
      messageId,
      pdfUrl: dto.pdfUrl,
      tone: dto.tone,
      length: dto.length,
      speakerType: dto.speakerType,
      notificationEmail: dto.notificationEmail,
    });
  }
}
