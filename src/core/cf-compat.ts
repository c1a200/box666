import type { TVBoxConfig } from './types';

/**
 * 兼容层已停用。
 *
 * 旧实现会按站点名称/Key 把 WoGG 源改写成另一套 API/JAR，这既违反
 * “只按已验证的 API + JAR MD5 + ext 契约处理”的边界，也会掩盖真实凭证
 * 协议，导致修好一个源后另一个源反而失效。保留同名导出只为兼容旧调用，
 * 但不再修改任何配置。
 */
export interface LegacyWoggMigration {
  oldKey: string;
  newKey: string;
}

export interface LegacyWoggMigrationResult {
  changed: boolean;
  keyMigrations: LegacyWoggMigration[];
}

export function migrateLegacyWoggCompatibility(_config: TVBoxConfig): LegacyWoggMigrationResult {
  return { changed: false, keyMigrations: [] };
}

export function applyLegacyWoggCompatibility(_config: TVBoxConfig): boolean {
  return false;
}

export const applyCloudflareCompatibility = applyLegacyWoggCompatibility;
