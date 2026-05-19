// V1 stubbed step actions for the onboarding magic-moment flow.
// Each function takes the user-provided URL and returns a small preview blob
// rendered inline as the SSE event for that step. Swap the bodies for real
// scraping / LLM calls in v1.1 — the contract stays the same.

export type StepId = "scrape" | "voice" | "icp" | "plan";

export type StepPreview =
  | { kind: "scrape"; pages: number; title: string; description: string }
  | { kind: "voice"; tone: string; adjectives: string[]; sample: string }
  | { kind: "icp"; segment: string; pains: string[]; channels: string[] }
  | { kind: "plan"; weeks: { label: string; items: string[] }[] };

export const STEP_ORDER: { id: StepId; label: string; sleepMs: number }[] = [
  { id: "scrape", label: "Scraping your site", sleepMs: 900 },
  { id: "voice", label: "Deriving brand voice fingerprint", sleepMs: 1100 },
  { id: "icp", label: "Drafting ICP hypothesis", sleepMs: 1000 },
  { id: "plan", label: "Building your 30-day plan", sleepMs: 1200 },
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0] || "your site";
  }
}

export async function runScrape(url: string, sleepMs: number): Promise<StepPreview> {
  await sleep(sleepMs);
  const host = hostOf(url);
  return {
    kind: "scrape",
    pages: 14,
    title: host,
    description: `Indexed home, pricing, about, and 11 other pages from ${host}.`,
  };
}

export async function runVoice(_url: string, sleepMs: number): Promise<StepPreview> {
  await sleep(sleepMs);
  return {
    kind: "voice",
    tone: "Confident, plainspoken, lightly technical",
    adjectives: ["direct", "credible", "warm"],
    sample: "Built for teams who'd rather ship than babysit dashboards.",
  };
}

export async function runIcp(_url: string, sleepMs: number): Promise<StepPreview> {
  await sleep(sleepMs);
  return {
    kind: "icp",
    segment: "Series A B2B SaaS, 20–80 employees, US/EU",
    pains: ["Marketing org too small for ambition", "Spend on Google Ads feels untracked"],
    channels: ["Google Ads", "SEO", "Cold email"],
  };
}

export async function runPlan(_url: string, sleepMs: number): Promise<StepPreview> {
  await sleep(sleepMs);
  return {
    kind: "plan",
    weeks: [
      {
        label: "Week 1",
        items: [
          "Audit Google Ads account; pause 4 underperforming keywords",
          "Stand up SEO baseline; pick 3 target pages",
        ],
      },
      {
        label: "Week 2",
        items: [
          "Draft cold email sequence for 50 warm leads",
          "Publish 1 SEO content piece against top intent keyword",
        ],
      },
      {
        label: "Week 3",
        items: [
          "Run bid optimization pass on top 12 Google Ads keywords",
          "Iterate cold email subject lines on lowest-open variant",
        ],
      },
      {
        label: "Week 4",
        items: [
          "Review what's working; reallocate budget toward best ROAS channel",
          "Propose next 30-day plan based on learnings",
        ],
      },
    ],
  };
}

export const STEP_RUNNERS: Record<StepId, (url: string, sleepMs: number) => Promise<StepPreview>> = {
  scrape: runScrape,
  voice: runVoice,
  icp: runIcp,
  plan: runPlan,
};
