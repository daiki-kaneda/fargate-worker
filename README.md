# Fargate Worker — Paper Summarization Pipeline

論文 PDF URL を SQS で受け取り、Bedrock (Claude 3.5) で要約・SSML 変換、Polly で音声合成し、SES メールで通知する AWS Fargate ワーカー。

## アーキテクチャ

```
Client → SQS Queue
              ↓  (Step Scaling: 6:1 比率で 0→N タスク)
         Fargate Worker
              ├── S3            (PDF 保存 / 音声ファイル保存)
              ├── DynamoDB      (ジョブ状態・冪等性管理)
              ├── Bedrock       (要約生成 + SSML 変換)
              ├── Polly         (Neural TTS → MP3)
              └── SES           (完了/失敗メール通知)

DLQ ← SQS (3 回受信失敗後に自動移動)
SNS ← CloudWatch Alarm (ERROR ログ急増時の開発者アラート)
```

### ジョブステータス遷移

```
RECEIVED → DOWNLOADING_PDF → SUMMARIZING → CONVERTING_SSML → GENERATING_AUDIO → COMPLETED
                                                                                 ↘ FAILED
```

## 前提条件

| 要件 | 詳細 |
|------|------|
| Node.js | 22 以上 |
| AWS CLI | 認証済み (`aws configure` または IAM Identity Center) |
| AWS CDK | `npm install -g aws-cdk` |
| SES 送信元メール | デプロイ前に SES コンソールでメールアドレスを検証しておくこと |
| ECR イメージ | CDK デプロイ後に Docker イメージを push する必要あり (下記参照) |

> **SES サンドボックス**: デフォルトでは検証済みアドレスにしか送信できません。任意の受信者に送信するには AWS サポートへ sandbox 解除を申請してください。

## セットアップ手順

### 1. 依存関係のインストール

```bash
# CDK (ルート)
npm ci

# ワーカー (src/)
cd src && npm ci && cd ..
```

### 2. CDK ブートストラップ (初回のみ)

```bash
npx cdk bootstrap
```

### 3. インフラのデプロイ

```bash
npx cdk deploy --parameters SenderEmail=<SES検証済みメールアドレス>
```

デプロイ後、CloudFormation Outputs に以下が出力されます:

| Output | 用途 |
|--------|------|
| `QueueUrl` | SQS エンドポイント (メッセージ送信先) |
| `WorkerRepositoryUri` | ECR リポジトリ URI (Docker push 先) |
| `ClusterName` / `ServiceName` | ECS サービス識別子 |

### 4. Docker イメージのビルド & Push

```bash
REPO_URI=$(aws cloudformation describe-stacks \
  --stack-name FargateWorkerStack \
  --query "Stacks[0].Outputs[?OutputKey=='WorkerRepositoryUri'].OutputValue" \
  --output text)

aws ecr get-login-password | docker login --username AWS --password-stdin "$REPO_URI"

docker build -t "$REPO_URI:latest" src/
docker push "$REPO_URI:latest"
```

### 5. ジョブの投入 (動作確認)

```bash
QUEUE_URL=$(aws cloudformation describe-stacks \
  --stack-name FargateWorkerStack \
  --query "Stacks[0].Outputs[?OutputKey=='QueueUrl'].OutputValue" \
  --output text)

aws sqs send-message \
  --queue-url "$QUEUE_URL" \
  --message-body '{
    "jobId": "00000000-0000-0000-0000-000000000001",
    "pdfUrl": "https://arxiv.org/pdf/2302.13971",
    "tone": "casual",
    "length": "short",
    "speakerType": "Joanna",
    "notificationEmail": "you@example.com"
  }'
```

## ローカルテスト

```bash
# CDK テスト (lib/ の構成検証)
npm test

# ワーカーユニットテスト (src/test/)
cd src && npm test

# カバレッジレポート
cd src && npm run test:coverage
```

## 環境変数一覧

ワーカーコンテナに渡される環境変数は CDK (`lib/constructs/compute.ts`) で管理されます。

| 変数名 | 必須 | デフォルト | 説明 |
|--------|------|-----------|------|
| `QUEUE_URL` | ✅ | — | SQS キュー URL |
| `PDF_BUCKET_NAME` | ✅ | — | PDF 保存 S3 バケット名 |
| `AUDIO_BUCKET_NAME` | ✅ | — | 音声ファイル S3 バケット名 |
| `JOB_TABLE_NAME` | ✅ | — | DynamoDB テーブル名 |
| `SENDER_EMAIL_ADDRESS` | ✅ | — | SES 送信元メールアドレス |
| `BEDROCK_MODEL_ID` | ✅ | `apac.anthropic.claude-3-5-sonnet-20241022-v2:0` | Bedrock 推論プロファイル ID |
| `AWS_DEFAULT_REGION` | — | `ap-northeast-1` | AWS リージョン |
| `LOG_LEVEL` | — | `INFO` | ログレベル (`DEBUG`/`INFO`/`WARN`/`ERROR`) |
| `PRESIGNED_URL_EXPIRES_IN` | — | `604800` (7日) | 音声ファイル署名付き URL の有効期間 (秒) |

## SQS メッセージスキーマ

```typescript
{
  jobId: string;              // クライアント生成 UUID (冪等性キー)
  pdfUrl: string;             // 論文 PDF の公開 URL
  tone: 'casual' | 'formal' | 'academic';
  length: 'short' | 'medium' | 'long';  // 目標語数: 300 / 600 / 1200
  speakerType: string;        // Polly VoiceId (例: 'Takumi', 'Joanna')
  notificationEmail: string;  // 完了通知先メールアドレス
}
```

## スケーリング戦略

| フェーズ | ポリシー | 詳細 |
|---------|---------|------|
| スケールアップ | Step Scaling (EXACT_CAPACITY) | visible メッセージ数に応じ 6:1 比率でタスク数を決定。最大 10 タスク |
| スケールダウン | Step Scaling (EXACT_CAPACITY) | visible + notVisible = 0 が **5 分継続** でタスク数を 0 に設定 |

## コスト最適化

- **NAT Gateway なし**: Fargate タスクはパブリックサブネット + パブリック IP で AWS API に接続
- **S3 / DynamoDB**: Gateway VPC Endpoint (無料) でルーティング
- **スケール to ゼロ**: アイドル時はタスク 0 台
