/** Type surface of lib.js for tests; the runtime module is plain ES JavaScript. */
export declare const numberWords: string[];
export declare const compact: Intl.NumberFormat;
export declare const integer: Intl.NumberFormat;
export declare const money: (value: number | null | undefined) => string;
export declare const percent: (value: number | null | undefined) => string;
export declare const share: (value: number) => string;
export declare const spelled: (value: number) => string;
export declare const plural: (value: number, singular: string, pluralForm?: string) => string;
export declare const shortDate: (day: string) => string;
export declare const longDate: (day: string) => string;
export declare function niceMaximum(maximum: number): number;
export declare function median(values: number[]): number | null;
export declare function nextChartIndex(key: string, activeIndex: number, length: number): number | "hide" | null;
export declare function peakDay<T extends { name: string }>(items: T[], providers: string[]): { name: string; value: number } | null;
export declare function windowPhrase(window: { start: string; end: string; min: string; max: string; preset: string }): string;
export interface LedePart { text?: string; strong?: string; className?: string }
export interface LedeSummary {
  sessions: number;
  repositoriesWithSessions: number;
  totalInputTokens: number;
  outputTokens: number;
  apiEquivalentSpendUsd: number;
  providerReportedSpendUsd: number;
}
export declare function ledeParts(input: {
  summary: LedeSummary;
  selectedName: string | null;
  phrase: string;
  valueByProvider: Record<string, number>;
  providerLabels: Record<string, string>;
  busiest: { name: string; sessions: number } | null;
  peak: { name: string; value: number } | null;
}): LedePart[];
