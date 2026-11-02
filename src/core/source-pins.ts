// 点播源置顶 scope、选择时间与会话合并。
// 数组顺序始终由 pinSelectedAt 派生，不能再用手工数组位置表达优先级。

export interface SourcePinScopes {
  pinnedKeys?: readonly string[];
  categoryPinnedKeys?: readonly string[];
  pinSelectedAt?: Readonly<Record<string, string>>;
}

export interface NormalizedSourcePins {
  pinnedKeys: string[];
  categoryPinnedKeys: string[];
  pinSelectedAt: Record<string, string>;
}

const MAX_SOURCE_PINS = 2000;
// 旧数据没有选择时间；使用远早于新操作且稳定的合成时间完成无损迁移。
const LEGACY_PIN_TIME_BASE = Date.UTC(2000, 0, 1);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((key): key is string => typeof key === 'string')
      .map((key) => key.trim())
      .filter(Boolean),
  )].slice(0, MAX_SOURCE_PINS);
}

function normalizeSelectedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function sortBySelectionTime(keys: readonly string[], selectedAt: Readonly<Record<string, string>>): string[] {
  const originalOrder = new Map(keys.map((key, index) => [key, index] as const));
  return [...keys].sort((a, b) => {
    const timeDiff = Date.parse(selectedAt[a]) - Date.parse(selectedAt[b]);
    if (timeDiff !== 0) return timeDiff;
    return (originalOrder.get(a) as number) - (originalOrder.get(b) as number);
  });
}

export function normalizeSourcePins(source: SourcePinScopes): NormalizedSourcePins {
  const pinnedKeys = normalizeKeys(source.pinnedKeys);
  const globalKeys = new Set(pinnedKeys);
  const categoryPinnedKeys = normalizeKeys(source.categoryPinnedKeys)
    .filter((key) => !globalKeys.has(key));
  const rawSelectedAt = asRecord(source.pinSelectedAt);
  const selectedAt: Record<string, string> = {};
  let legacySequence = 0;

  const assignSelectionTime = (key: string) => {
    const existing = normalizeSelectedAt(rawSelectedAt[key]);
    selectedAt[key] = existing ?? new Date(LEGACY_PIN_TIME_BASE + legacySequence++).toISOString();
  };

  // 旧数组没有时间。先按总榜、再按分类的原数组顺序生成稳定旧时间；
  // 所有新置顶使用当前时间，因此一定排在迁移项之后。
  pinnedKeys.forEach(assignSelectionTime);
  categoryPinnedKeys.forEach(assignSelectionTime);

  return {
    pinnedKeys: sortBySelectionTime(pinnedKeys, selectedAt),
    categoryPinnedKeys: sortBySelectionTime(categoryPinnedKeys, selectedAt),
    pinSelectedAt: selectedAt,
  };
}

/**
 * 将一次配置写入收敛为不可变的选择时间：
 * - 已在同一 scope 中：保留原选择时间，重排/重复提交不刷新；
 * - 新置顶或跨 scope 移动：记录本次选择时间；
 * - 被删除的 key：同时清理时间。
 */
export function reconcileSourcePins(
  previous: SourcePinScopes,
  desired: SourcePinScopes,
  selectedAt = new Date().toISOString(),
): NormalizedSourcePins {
  const before = normalizeSourcePins(previous);
  const pinnedKeys = normalizeKeys(desired.pinnedKeys);
  const globalKeys = new Set(pinnedKeys);
  const categoryPinnedKeys = normalizeKeys(desired.categoryPinnedKeys)
    .filter((key) => !globalKeys.has(key));
  const beforeGlobal = new Set(before.pinnedKeys);
  const beforeCategory = new Set(before.categoryPinnedKeys);
  const requestedTimes = asRecord(desired.pinSelectedAt);
  const pinSelectedAt: Record<string, string> = {};

  const assign = (key: string, sameScope: boolean) => {
    const requested = normalizeSelectedAt(requestedTimes[key]);
    pinSelectedAt[key] = sameScope
      ? (before.pinSelectedAt[key] || requested || selectedAt)
      : selectedAt;
  };

  pinnedKeys.forEach((key) => assign(key, beforeGlobal.has(key)));
  categoryPinnedKeys.forEach((key) => assign(key, beforeCategory.has(key)));

  return {
    pinnedKeys: sortBySelectionTime(pinnedKeys, pinSelectedAt),
    categoryPinnedKeys: sortBySelectionTime(categoryPinnedKeys, pinSelectedAt),
    pinSelectedAt,
  };
}

/** 根链接置顶对鉴权链接生效；同一 key 的总榜 scope 优先于分类 scope。 */
export function mergeSourcePins(base: SourcePinScopes, extra: SourcePinScopes): NormalizedSourcePins {
  const left = normalizeSourcePins(base);
  const right = normalizeSourcePins(extra);
  const pinSelectedAt: Record<string, string> = {};

  const globalKeys: string[] = [];
  const categoryKeys: string[] = [];
  const globalSet = new Set<string>();
  const categorySet = new Set<string>();

  const addGlobal = (key: string, selectedAt: string) => {
    if (!globalSet.has(key)) {
      globalSet.add(key);
      globalKeys.push(key);
    }
    const existing = pinSelectedAt[key];
    if (!existing || Date.parse(selectedAt) < Date.parse(existing)) pinSelectedAt[key] = selectedAt;
  };
  const addCategory = (key: string, selectedAt: string) => {
    if (globalSet.has(key) || categorySet.has(key)) return;
    categorySet.add(key);
    categoryKeys.push(key);
    pinSelectedAt[key] = selectedAt;
  };

  left.pinnedKeys.forEach((key) => addGlobal(key, left.pinSelectedAt[key]));
  right.pinnedKeys.forEach((key) => addGlobal(key, right.pinSelectedAt[key]));
  // 同 key 即使分类置顶时间更早，也由总榜置顶 scope 接管时间与排序。
  left.categoryPinnedKeys.forEach((key) => addCategory(key, left.pinSelectedAt[key]));
  right.categoryPinnedKeys.forEach((key) => addCategory(key, right.pinSelectedAt[key]));

  return {
    pinnedKeys: sortBySelectionTime(globalKeys, pinSelectedAt),
    categoryPinnedKeys: sortBySelectionTime(categoryKeys, pinSelectedAt),
    pinSelectedAt,
  };
}