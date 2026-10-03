// Type declarations for the dependency-free chart helpers served to the dashboard (chart-geometry.js).

export interface EndLabel {
  y: number;
  moved: boolean;
}

export interface DonutSegment {
  name: string;
  share: number;
}

export interface DonutStop {
  name: string;
  start: number;
  end: number;
}

export function positionAt(index: number, left: number, plotWidth: number, count: number): number;
export function nearestIndex(x: number, left: number, plotWidth: number, count: number): number;
export function layoutEndLabels(targets: number[], min: number, max: number, gap: number): EndLabel[];
export function donutStops(segments: DonutSegment[], gap?: number): DonutStop[];
export function donutGradient(stops: DonutStop[], surface?: string): string;
export function sharePercent(value: number, total: number): string;
