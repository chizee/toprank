import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Fixed 32-byte AES-256 key so the round-trip is deterministic.
  getMasterKey: vi.fn(async () => Buffer.alloc(32, 7)),
}));

vi.mock("./master-key", () => ({ getMasterKey: mocks.getMasterKey }));

import { decrypt, encrypt } from "./cipher";

beforeEach(() => vi.clearAllMocks());

describe("encrypt / decrypt round-trip", () => {
  it("recovers the original plaintext", async () => {
    const secret = "hello world 🌍 token=abc123";
    const blob = await encrypt(secret);
    expect(blob).not.toContain(secret);
    expect(await decrypt(blob)).toBe(secret);
  });

  it("recovers an empty string", async () => {
    const blob = await encrypt("");
    expect(await decrypt(blob)).toBe("");
  });

  it("produces a distinct ciphertext each time (random IV)", async () => {
    const a = await encrypt("same");
    const b = await encrypt("same");
    expect(a).not.toBe(b);
    expect(await decrypt(a)).toBe("same");
    expect(await decrypt(b)).toBe("same");
  });

  it("outputs valid base64 wrapping iv|ciphertext|tag", async () => {
    const blob = await encrypt("x");
    const buf = Buffer.from(blob, "base64");
    // 12-byte IV + 16-byte tag + >=1 ciphertext byte
    expect(buf.length).toBeGreaterThanOrEqual(12 + 16 + 1);
  });
});

describe("decrypt error handling", () => {
  it("throws on a blob too short to hold iv+tag", async () => {
    await expect(decrypt(Buffer.alloc(5).toString("base64"))).rejects.toThrow(
      /malformed/,
    );
  });

  it("throws when the auth tag does not verify (tampered ciphertext)", async () => {
    const blob = await encrypt("tamper me");
    const buf = Buffer.from(blob, "base64");
    buf[13] = buf[13]! ^ 0xff; // flip a ciphertext byte
    await expect(decrypt(buf.toString("base64"))).rejects.toThrow();
  });

  it("throws when decrypted with a different key", async () => {
    const blob = await encrypt("wrong key");
    mocks.getMasterKey.mockResolvedValueOnce(Buffer.alloc(32, 9));
    await expect(decrypt(blob)).rejects.toThrow();
  });
});
