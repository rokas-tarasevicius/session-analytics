export interface LegendItem {
  id: string;
  label: string;
  color: string;
  value?: number;
  valueLabel?: string;
  /** Fraction (0..1), or a preformatted percentage. */
  share?: number | string;
  mark: "rect" | "line" | "logo";
  pattern?: "solid" | "diagonal" | "dashed" | "marker";
  icon?: object;
}
/** Structural DOM contracts keep browser globals out of the Node test type environment. */
export interface LegendMark {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface LegendTarget extends LegendMark {
  classList: { add(...tokens: string[]): void };
  querySelectorAll(selector: string): Iterable<LegendMark>;
}
export interface LegendContainer extends LegendTarget {
  dataset: Record<string, string | undefined>;
  replaceChildren(): void;
}
export interface LegendOptions { target: LegendTarget; layout?: "wrap" | "list" }
export function renderLegend(container: LegendContainer, items: LegendItem[], options: LegendOptions): void;
