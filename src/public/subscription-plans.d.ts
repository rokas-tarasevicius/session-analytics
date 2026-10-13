export interface SubscriptionPlan { id: string; label: string; monthlyUsd: number | null; rank: number; source: string }
export const plansReviewedAt: string;
export const subscriptionPlans: { claude: SubscriptionPlan[]; codex: SubscriptionPlan[] };
export function planFor(provider: "claude" | "codex", id: string | null | undefined): SubscriptionPlan | null;
