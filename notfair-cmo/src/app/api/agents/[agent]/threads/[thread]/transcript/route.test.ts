import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/types";

const getActiveProjectMock = vi.fn();
vi.mock("@/server/active-project", () => ({
  getActiveProject: (...args: unknown[]) => getActiveProjectMock(...args),
}));

const getProjectMock = vi.fn();
vi.mock("@/server/db/projects", () => ({
  getProject: (...args: unknown[]) => getProjectMock(...args),
}));

const resolveAgentBySlugMock = vi.fn();
vi.mock("@/server/agent-meta", () => ({
  resolveAgentBySlug: (...args: unknown[]) => resolveAgentBySlugMock(...args),
}));

const readTranscriptTailMock = vi.fn();
vi.mock("@/server/openclaw/transcript-tail", () => ({
  readTranscriptTail: (...args: unknown[]) => readTranscriptTailMock(...args),
}));

import { GET } from "./route";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "id",
    slug: "acme",
    display_name: "Acme",
    created_at: "now",
    archived_at: null,
    google_ads_account_id: null,
    website_url: null,
    codebase_path: null,
    ...overrides,
  };
}

function makeReq(url: string): Request {
  return new Request(url, { method: "GET" });
}

describe("GET /api/agents/[agent]/threads/[thread]/transcript", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when no project param and no active project", async () => {
    getActiveProjectMock.mockResolvedValueOnce(null);
    const res = await GET(
      makeReq("http://localhost/api/agents/cmo/threads/t1/transcript"),
      { params: Promise.resolve({ agent: "cmo", thread: "t1" }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no active project");
  });

  it("uses explicit project query param when present", async () => {
    getProjectMock.mockReturnValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    readTranscriptTailMock.mockReturnValueOnce({
      events: [],
      byteOffset: 0,
      fileSize: 0,
    });
    await GET(
      makeReq(
        "http://localhost/api/agents/cmo/threads/t1/transcript?project=acme",
      ),
      { params: Promise.resolve({ agent: "cmo", thread: "t1" }) },
    );
    expect(getProjectMock).toHaveBeenCalledWith("acme");
    expect(getActiveProjectMock).not.toHaveBeenCalled();
  });

  it("falls back to active project when no query param", async () => {
    getActiveProjectMock.mockResolvedValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    readTranscriptTailMock.mockReturnValueOnce({
      events: [],
      byteOffset: 0,
      fileSize: 0,
    });
    await GET(
      makeReq("http://localhost/api/agents/cmo/threads/t1/transcript"),
      { params: Promise.resolve({ agent: "cmo", thread: "t1" }) },
    );
    expect(getActiveProjectMock).toHaveBeenCalled();
    expect(getProjectMock).not.toHaveBeenCalled();
  });

  it("returns 404 when agent slug cannot be resolved", async () => {
    getProjectMock.mockReturnValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce(null);
    const res = await GET(
      makeReq(
        "http://localhost/api/agents/ghost/threads/t1/transcript?project=acme",
      ),
      { params: Promise.resolve({ agent: "ghost", thread: "t1" }) },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unknown agent");
  });

  it("returns events + byte offset + file size on success", async () => {
    getProjectMock.mockReturnValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    const events = [
      { kind: "user_message", id: "1", ts: 0, body: "hi" },
    ];
    readTranscriptTailMock.mockReturnValueOnce({
      events,
      byteOffset: 100,
      fileSize: 100,
    });
    const res = await GET(
      makeReq(
        "http://localhost/api/agents/cmo/threads/t1/transcript?project=acme&offset=50",
      ),
      { params: Promise.resolve({ agent: "cmo", thread: "t1" }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: unknown[];
      byteOffset: number;
      file_size: number;
    };
    expect(body.events).toEqual(events);
    expect(body.byteOffset).toBe(100);
    expect(body.file_size).toBe(100);
    expect(readTranscriptTailMock).toHaveBeenCalledWith("acme-cmo", "t1", 50);
  });

  it("treats missing offset query param as 0", async () => {
    getProjectMock.mockReturnValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    readTranscriptTailMock.mockReturnValueOnce({
      events: [],
      byteOffset: 0,
      fileSize: 0,
    });
    await GET(
      makeReq(
        "http://localhost/api/agents/cmo/threads/t1/transcript?project=acme",
      ),
      { params: Promise.resolve({ agent: "cmo", thread: "t1" }) },
    );
    expect(readTranscriptTailMock).toHaveBeenCalledWith("acme-cmo", "t1", 0);
  });

  it("clamps negative offset to 0", async () => {
    getProjectMock.mockReturnValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    readTranscriptTailMock.mockReturnValueOnce({
      events: [],
      byteOffset: 0,
      fileSize: 0,
    });
    await GET(
      makeReq(
        "http://localhost/api/agents/cmo/threads/t1/transcript?project=acme&offset=-5",
      ),
      { params: Promise.resolve({ agent: "cmo", thread: "t1" }) },
    );
    expect(readTranscriptTailMock).toHaveBeenCalledWith("acme-cmo", "t1", 0);
  });

  it("clamps non-numeric offset to 0", async () => {
    getProjectMock.mockReturnValueOnce(makeProject({ slug: "acme" }));
    resolveAgentBySlugMock.mockResolvedValueOnce({
      agent_id: "acme-cmo",
      display_name: "CMO",
      slug: "cmo",
    });
    readTranscriptTailMock.mockReturnValueOnce({
      events: [],
      byteOffset: 0,
      fileSize: 0,
    });
    await GET(
      makeReq(
        "http://localhost/api/agents/cmo/threads/t1/transcript?project=acme&offset=notanumber",
      ),
      { params: Promise.resolve({ agent: "cmo", thread: "t1" }) },
    );
    expect(readTranscriptTailMock).toHaveBeenCalledWith("acme-cmo", "t1", 0);
  });
});
