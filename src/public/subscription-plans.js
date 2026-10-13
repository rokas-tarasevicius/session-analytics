// Subscription plans and list prices, reviewed 2026-10-13. Prices change; the dashboard lets you override the plan, and
// capacity is never taken from this table: it is calibrated from your own limit meters.

export const plansReviewedAt = "2026-10-13";

/** `rank` orders tiers within a provider for upgrade/downgrade suggestions; `null` price means seat or contract pricing. */
export const subscriptionPlans = {
  claude: [
    { id: "pro", label: "Claude Pro", monthlyUsd: 20, rank: 1, source: "https://claude.com/pricing" },
    { id: "max-5x", label: "Claude Max 5x", monthlyUsd: 100, rank: 2, source: "https://support.claude.com/en/articles/11049741-what-is-the-max-plan" },
    { id: "max-20x", label: "Claude Max 20x", monthlyUsd: 200, rank: 3, source: "https://support.claude.com/en/articles/11049741-what-is-the-max-plan" },
    { id: "team", label: "Claude Team (premium seat)", monthlyUsd: 125, rank: 2, source: "https://claude.com/pricing" },
    { id: "enterprise", label: "Claude Enterprise", monthlyUsd: null, rank: 3, source: "https://claude.com/pricing" },
  ],
  codex: [
    { id: "go", label: "ChatGPT Go", monthlyUsd: 8, rank: 0, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "plus", label: "ChatGPT Plus", monthlyUsd: 20, rank: 1, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "prolite", label: "ChatGPT Pro Lite", monthlyUsd: 100, rank: 2, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "pro", label: "ChatGPT Pro", monthlyUsd: 200, rank: 3, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "team", label: "ChatGPT Team", monthlyUsd: 25, rank: 1, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "business", label: "ChatGPT Business", monthlyUsd: 25, rank: 1, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "enterprise", label: "ChatGPT Enterprise", monthlyUsd: null, rank: 3, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "edu", label: "ChatGPT Edu", monthlyUsd: null, rank: 1, source: "https://learn.chatgpt.com/docs/pricing" },
    { id: "free", label: "ChatGPT Free", monthlyUsd: 0, rank: 0, source: "https://learn.chatgpt.com/docs/pricing" },
  ],
};

export function planFor(provider, id) {
  return subscriptionPlans[provider]?.find((plan) => plan.id === id) ?? null;
}
