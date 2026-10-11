import type { SearchQualityEntry, SiteQualityGrade } from './types';

const SCORE_BY_GRADE: Record<SiteQualityGrade, number> = {
  excellent: 900,
  good: 760,
  usable: 600,
  // Client-verifiable sources are deliberately below every server-verified
  // source. They can be opted in, but must not silently win a top-N list.
  untestable: 420,
  timeout: 80,
  unusable: 0,
};

export function normalizeQualityGrade(value: unknown): SiteQualityGrade {
  if (value === 'unknown') return 'timeout';
  if (value === 'credential-ready') return 'untestable';
  if (value === 'excellent' || value === 'good' || value === 'usable'
    || value === 'untestable' || value === 'timeout' || value === 'unusable') {
    return value;
  }
  return 'timeout';
}

export function qualityScoreForEntry(entry: Pick<SearchQualityEntry, 'grade' | 'speedMs' | 'consecutiveFailures' | 'qualityScore'>): number {
  if (typeof entry.qualityScore === 'number' && Number.isFinite(entry.qualityScore)) {
    return Math.max(0, Math.min(1000, Math.round(entry.qualityScore)));
  }
  return calculateQualityScore(entry);
}

/**
 * Calculate the score from raw quality signals.  Keep this separate from
 * qualityScoreForEntry: persisted snapshots may already contain a score, but
 * grading a fresh entry must never depend on that persisted value.
 */
export function calculateQualityScore(
  entry: Pick<SearchQualityEntry, 'grade' | 'speedMs' | 'consecutiveFailures' | 'jarProbeResult'>,
): number {
  let score = SCORE_BY_GRADE[normalizeQualityGrade(entry.grade)];
  if (typeof entry.speedMs === 'number' && Number.isFinite(entry.speedMs)) {
    score += Math.max(0, 80 - Math.min(80, entry.speedMs / 100));
  }
  if (normalizeQualityGrade(entry.grade) === 'untestable' && entry.jarProbeResult === 'ok') {
    // A valid remote JAR is still client-executed, but its metadata is known
    // to be fetchable and structurally valid, so it is a better fallback than
    // an entirely unverified extension.
    score += 140;
  }
  score -= Math.min(180, Math.max(0, entry.consecutiveFailures || 0) * 60);
  return Math.max(0, Math.min(1000, Math.round(score)));
}

export function qualityConfidenceForEntry(entry: Pick<SearchQualityEntry, 'grade' | 'jarProbeResult' | 'qualityConfidence'>): number {
  if (typeof entry.qualityConfidence === 'number' && Number.isFinite(entry.qualityConfidence)) {
    return Math.max(0, Math.min(1, entry.qualityConfidence));
  }
  const grade = normalizeQualityGrade(entry.grade);
  if (grade === 'excellent' || grade === 'good' || grade === 'usable') return 0.85;
  if (grade === 'untestable') return entry.jarProbeResult === 'ok' ? 0.55 : 0.25;
  return 0;
}

/** Higher quality first. The key tie-breaker makes output deterministic. */
export function compareQualityEntries(a: SearchQualityEntry, b: SearchQualityEntry): number {
  const scoreDiff = qualityScoreForEntry(b) - qualityScoreForEntry(a);
  if (scoreDiff !== 0) return scoreDiff;
  const confidenceDiff = qualityConfidenceForEntry(b) - qualityConfidenceForEntry(a);
  if (confidenceDiff !== 0) return confidenceDiff;
  return a.key.localeCompare(b.key);
}

export function qualityGradeRank(value: unknown): number {
  return ({ excellent: 0, good: 1, usable: 2, untestable: 3, timeout: 4, unusable: 5 } as Record<SiteQualityGrade, number>)[normalizeQualityGrade(value)];
}
