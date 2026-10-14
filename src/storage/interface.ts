// 平台无关的 KV 存储接口

export interface Storage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  // 绕过“值未变化则跳过写”的优化，仅用于必须确保状态切换落盘的键。
  putForced?(key: string, value: string): Promise<void>;
  getDiagnostics?(): Record<string, unknown> | Promise<Record<string, unknown>>;
}
