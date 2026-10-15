// Subscription plans and list prices, reviewed 2026-10-14 from claude.com/pricing, the Claude Max plan article,
// learn.chatgpt.com/docs/pricing and OpenAI's Pro tiers article. Prices change; the dashboard lets you override the plan,
// and capacity is never taken from this table: it is calibrated from your own limit meters.

export const plansReviewedAt = "2026-10-14";

const claudePricing = "https://claude.com/pricing";
const maxPlan = "https://support.claude.com/en/articles/11049741-what-is-the-max-plan";
const chatgptPricing = "https://learn.chatgpt.com/docs/pricing";
const proTiers = "https://help.openai.com/articles/9793128-about-chatgpt-pro-tiers";

/**
 * `monthlyUsd` is the month-to-month price and `annualMonthlyUsd` the monthly equivalent when billed yearly; `null` means
 * contract or usage-based pricing. `payer: "organization"` marks seats an employer or workspace pays for: they get API
 * value without a personal price multiple. `rank` orders tiers within a provider for upgrade and downgrade suggestions.
 * Plans whose `id` is a provider plan enum are detected automatically; seat types are chosen by hand.
 */
export const subscriptionPlans = {
  claude: [
    { id: "pro", label: "Claude Pro", monthlyUsd: 20, annualMonthlyUsd: 17, payer: "individual", rank: 1, source: claudePricing },
    { id: "max-5x", label: "Claude Max 5x", monthlyUsd: 100, annualMonthlyUsd: null, payer: "individual", rank: 2, source: maxPlan },
    { id: "max-20x", label: "Claude Max 20x", monthlyUsd: 200, annualMonthlyUsd: null, payer: "individual", rank: 3, source: maxPlan },
    { id: "team", label: "Claude Team (seat type unknown)", monthlyUsd: null, annualMonthlyUsd: null, payer: "organization", rank: 2, source: claudePricing },
    { id: "team-standard", label: "Claude Team standard seat", monthlyUsd: 25, annualMonthlyUsd: 20, payer: "organization", rank: 1, source: claudePricing },
    { id: "team-premium", label: "Claude Team premium seat", monthlyUsd: 125, annualMonthlyUsd: 100, payer: "organization", rank: 2, source: claudePricing },
    // $20 a seat a month billed annually, plus usage at API rates.
    { id: "enterprise", label: "Claude Enterprise", monthlyUsd: null, annualMonthlyUsd: 20, payer: "organization", rank: 3, source: claudePricing },
  ],
  codex: [
    { id: "free", label: "ChatGPT Free", monthlyUsd: 0, annualMonthlyUsd: null, payer: "individual", rank: 0, source: chatgptPricing },
    { id: "go", label: "ChatGPT Go", monthlyUsd: 8, annualMonthlyUsd: null, payer: "individual", rank: 0, source: chatgptPricing },
    { id: "plus", label: "ChatGPT Plus", monthlyUsd: 20, annualMonthlyUsd: null, payer: "individual", rank: 1, source: chatgptPricing },
    { id: "prolite", label: "ChatGPT Pro 100", monthlyUsd: 100, annualMonthlyUsd: null, payer: "individual", rank: 2, source: proTiers },
    { id: "pro", label: "ChatGPT Pro 200", monthlyUsd: 200, annualMonthlyUsd: null, payer: "individual", rank: 3, source: proTiers },
    // Not detected: Codex has a `promax` plan type, but nothing confirms it is this tier.
    { id: "pro-500", label: "ChatGPT Pro 500", monthlyUsd: 500, annualMonthlyUsd: null, payer: "individual", rank: 4, source: proTiers },
    // ChatGPT Team was renamed Business; older records still say `team`.
    { id: "business", label: "ChatGPT Business", monthlyUsd: 25, annualMonthlyUsd: 20, payer: "organization", rank: 1, source: chatgptPricing },
    { id: "team", label: "ChatGPT Business (Team)", monthlyUsd: 25, annualMonthlyUsd: 20, payer: "organization", rank: 1, source: chatgptPricing },
    { id: "enterprise", label: "ChatGPT Enterprise", monthlyUsd: null, annualMonthlyUsd: null, payer: "organization", rank: 3, source: chatgptPricing },
    { id: "edu", label: "ChatGPT Edu", monthlyUsd: null, annualMonthlyUsd: null, payer: "organization", rank: 1, source: chatgptPricing },
  ],
};

export function planFor(provider, id) {
  return subscriptionPlans[provider]?.find((plan) => plan.id === id) ?? null;
}

/** The highest tier a provider sells to individuals, so a capped top-tier plan is never told to upgrade. */
export const topRank = (provider) => Math.max(...(subscriptionPlans[provider] ?? []).filter((plan) => plan.payer === "individual").map((plan) => plan.rank));
