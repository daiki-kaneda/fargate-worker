import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { Job, JobSnapshot } from '../../domain/entities/Job';
import { JobRepositoryPort } from '../../domain/ports/JobRepositoryPort';
import { Logger } from '../../shared/logger/Logger';

export class DynamoDbJobRepository implements JobRepositoryPort {
  private readonly docClient: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    private readonly logger: Logger,
  ) {
    this.docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async save(job: Job): Promise<void> {
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: job.toSnapshot(),
      }),
    );
    this.logger.debug({ msg: 'Job record saved', jobId: job.jobId, status: job.status });
  }

  async findByMessageId(messageId: string): Promise<Job | null> {
    const response = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'messageId-index',
        KeyConditionExpression: 'messageId = :mid',
        ExpressionAttributeValues: { ':mid': messageId },
        Limit: 1,
      }),
    );

    const item = response.Items?.[0];
    return item ? Job.fromSnapshot(item as JobSnapshot) : null;
  }
}
