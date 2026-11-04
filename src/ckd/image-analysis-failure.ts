/** Failure presentation only: never a valid visual observation or calibration sample. */
export class ImageAnalysisProtocolError extends Error {}
export interface ImageAnalysisFailure {
  status: 'analysis_failed'; score: 0; reminder: true; analysisSucceeded: false; retryable: true;
  imageHash: string; ruleVersion: string; scoreVersion: string; failedAt: string;
  outputContractVersion?: string;
  error: string; reason: string; recommendations: string[]; cached: boolean;
}
export const IMAGE_FAILURE_REASON='分析结果不符合格式或输出不完整，评分失败；0 分为兜底值，不代表图片实际质量。';
export const IMAGE_FAILURE_REPORT_NOTE='模型输出结构失败或截断的图片以0分兜底并强制警告，按不同图片计入平均分；这不代表图片实际质量。失败记录独立于成功观察缓存，可显式重试。';
