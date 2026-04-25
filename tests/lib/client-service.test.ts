import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveUserEmail } from "../../src/lib/client-service.js";

let fetchSpy: ReturnType<typeof vi.fn>;

const identity = { orgId: "org_123", userId: "user_456", runId: "run_abc" };

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveUserEmail", () => {
  it("calls GET /internal/users/{userId} on client-service", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ user: { id: "user_456", email: "test@example.com", firstName: "Test", lastName: "User" } }),
    });

    const email = await resolveUserEmail("user_456", identity);

    expect(email).toBe("test@example.com");
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("/internal/users/user_456");
  });

  it("throws when user has no email", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ user: { id: "user_456", email: null, firstName: null, lastName: null } }),
    });

    await expect(resolveUserEmail("user_456", identity)).rejects.toThrow("No email found for user user_456");
  });

  it("throws on non-OK response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve("User not found"),
    });

    await expect(resolveUserEmail("user_456", identity)).rejects.toThrow("client-service GET /internal/users/user_456 failed: 404");
  });

  it("forwards identity headers", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ user: { id: "user_456", email: "test@example.com", firstName: null, lastName: null } }),
    });

    await resolveUserEmail("user_456", identity);

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers["x-org-id"]).toBe("org_123");
    expect(options.headers["x-user-id"]).toBe("user_456");
    expect(options.headers["x-run-id"]).toBe("run_abc");
  });
});
