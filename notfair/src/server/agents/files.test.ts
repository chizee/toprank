import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ workspace: "" }));
vi.mock("./provisioning", () => ({ workspaceDirFor: () => mocks.workspace }));

import { getAgentFile, listAgentFiles } from "./files";

beforeAll(async () => {
  mocks.workspace = await mkdtemp(join(tmpdir(), "notfair-files-"));
  await writeFile(join(mocks.workspace, "README.md"), "hello", "utf8");
  await mkdir(join(mocks.workspace, "folder"));
});

it("returns an empty list for a missing workspace", async () => {
  const saved = mocks.workspace;
  mocks.workspace = join(saved, "missing");
  await expect(listAgentFiles("a")).resolves.toEqual({ files: [], workspace: mocks.workspace });
  mocks.workspace = saved;
});

it("lists only regular files with metadata", async () => {
  const result = await listAgentFiles("a");
  expect(result.workspace).toBe(mocks.workspace);
  expect(result.files).toEqual([expect.objectContaining({ name: "README.md", size: 5, missing: false })]);
});

it("reads a file and rejects path traversal", async () => {
  await expect(getAgentFile("a", "README.md")).resolves.toMatchObject({ file: { name: "README.md", content: "hello", size: 5 } });
  await expect(getAgentFile("a", "../secret")).rejects.toThrow(/Invalid file name/);
  await expect(getAgentFile("a", "nested/file")).rejects.toThrow(/Invalid file name/);
});
