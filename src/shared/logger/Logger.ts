import pino from 'pino';

export type Logger = pino.Logger;

/**
 * CloudWatch Logs 向けに最適化した構造化 JSON ロガーを生成する。
 *
 * 出力フォーマット:
 * { "level": "INFO", "time": 1234567890, "msg": "...", ...contextFields }
 *
 * CloudWatch Metric Filter は $.level フィールドを使ってエラー数をカウントする。
 */
export function createLogger(logLevel: string): Logger {
  return pino({
    level: logLevel.toLowerCase(),
    formatters: {
      // pino デフォルトは数値 level なので大文字文字列に変換
      level: (label) => ({ level: label.toUpperCase() }),
    },
    // CloudWatch はタイムスタンプ付きで受信するため、epoch ms で十分
    timestamp: pino.stdTimeFunctions.epochTime,
  });
}
