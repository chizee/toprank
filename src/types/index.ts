// Shared types. Imported by both server (Next.js API + MCP) and client (React).

export type Project = {
  id: string;
  slug: string;
  display_name: string;
  created_at: string;
  archived_at: string | null;
  /**
   * Selected Google Ads customer ID for this project. Bearers from
   * notfair.co/api/mcp/google_ads can grant access to multiple customer
   * accounts; the onboarding flow asks the user to pick one and persists
   * it here so the audit + later automation target the right account.
   * Null until the user picks (or until /onboarding gets re-run).
   */
  google_ads_account_id: string | null;
};

export type TaskStatus =
  | "proposed"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

// ┌──────────┐  approve(within guardrails)  ┌──────────┐  agent picks up  ┌─────────┐
// │ proposed │ ─────────────────────────────▶│ approved │ ────────────────▶│ running │
// └──────────┘  needs_approval               └──────────┘                   └────┬────┘
//      │   ▲                                                                     │
//      │   └── user approves from inbox ──────────────────────────────┐         │
//      │                                                              │         ▼
//      │                                                       ┌───────────────┐
//      └─ user/CMO cancels ───────────────────────────────────▶│ cancelled / failed / succeeded │
//                                                              └───────────────┘
export type Task = {
  id: string;
  project_slug: string;
  agent_id: string;
  brief: string;
  success_criteria: string | null;
  deadline_iso: string | null;
  status: TaskStatus;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalType =
  | "spend"
  | "content_publishing"
  | "new_channel"
  | "bid_change"
  | "audience_change"
  | "other";

export type Approval = {
  id: string;
  project_slug: string;
  agent_id: string;
  action_summary: string;
  action_type: ApprovalType;
  cost_estimate_usd: number;
  reasoning: string | null;
  payload_json: string;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
};

export type CostEventSource = "llm" | "google_ads" | "gsc" | "other";

export type CostEvent = {
  id: string;
  project_slug: string;
  agent_id: string | null;
  source: CostEventSource;
  amount_usd: number;
  ref: string | null;
  occurred_at: string;
};

export type OAuthProvider = "google_ads" | "gsc";

export type OAuthToken = {
  id: string;
  project_slug: string;
  provider: OAuthProvider;
  account_label: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: string;
  scope: string;
  created_at: string;
  updated_at: string;
};

export type Guardrails = {
  project_slug: string;
  max_daily_spend_usd: number;
  max_concurrent_experiments: number;
  require_approval_above: {
    spend_per_action_usd: number;
    new_channel_first_action: boolean;
    content_publishing: boolean;
    bid_changes_percent: number;
    audience_change: boolean;
  };
};

export type ToolErrorEnvelope = {
  ok: false;
  error_code: string;
  message: string;
  retryable: boolean;
  user_message: string;
};

export type ToolSuccessEnvelope<T> = {
  ok: true;
  data: T;
};

export type ToolResult<T> = ToolSuccessEnvelope<T> | ToolErrorEnvelope;
