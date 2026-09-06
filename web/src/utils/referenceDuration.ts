/** 与发送给探测接口的基准片长保持同一口径，匹配不到有效分钟数则不核验。 */
export function referenceDurationSeconds(duration?: string): number | undefined {
  const match = duration?.match(/(\d+)\s*分钟/);
  const seconds = match ? Number(match[1]) * 60 : 0;
  return hasReferenceDuration(seconds) ? seconds : undefined;
}

export function hasReferenceDuration(seconds?: number): boolean {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0;
}
