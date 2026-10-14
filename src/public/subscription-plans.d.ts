export type PlanPayer = "individual" | "organization";
export interface SubscriptionPlan { id: string; label: string; monthlyUsd: number | null; annualMonthlyUsd: number | null; payer: PlanPayer; rank: number; source: string }
export const plansReviewedAt: string;
export const subscriptionPlans: { claude: SubscriptionPlan[]; codex: SubscriptionPlan[] };
export function planFor(provider: "claude" | "codex", id: string | null | undefined): SubscriptionPlan | null;
export function topRank(provider: "claude" | "codex"): number;
