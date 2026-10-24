import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: {} }));

import { sql } from "../../src/db/index.js";
import { nameSubscribersAtApollo, NAMED_SUBJECTS_CHUNK, RELEASE_VERIFY_LABEL } from "../../src/lib/ledger-subjects.js";

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `a${i}@x.com`, subscriber_id: `sub-${i}` }));

describe("nameSubscribersAtApollo", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.APOLLO_SERVICE_URL = "http://apollo";
    process.env.APOLLO_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.mocked(sql).mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names every address once per call of <= 500, under the release's own label, and sums apollo's answers", async () => {
    vi.mocked(sql).mockResolvedValueOnce(rows(NAMED_SUBJECTS_CHUNK + 1) as any);
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const n = body.subjects.length;
      return new Response(JSON.stringify({ dryRun: body.dryRun, subjects: n, checks: n * 2, subjectsWithoutCheck: 1, parked: body.dryRun ? 0 : n * 2 }), { status: 200 });
    });

    const report = await nameSubscribersAtApollo({ dryRun: false });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://apollo/internal/outcome-declarations/named-subjects");
    expect(init.headers["x-api-key"]).toBe("k");
    const first = JSON.parse(init.body);
    expect(first.callerLabel).toBe(RELEASE_VERIFY_LABEL);
    expect(first.subjects).toHaveLength(NAMED_SUBJECTS_CHUNK);
    expect(first.subjects[0]).toEqual({ email: "a0@x.com", subjectService: "transactional-email-service", subjectId: "sub-0" });
    expect(report).toEqual({ dryRun: false, calls: 2, subjects: 501, checks: 1002, subjectsWithoutCheck: 2, parked: 1002 });
  });

  it("is the same label the release verifies under", async () => {
    const src = await import("node:fs").then((fs) => fs.readFileSync("src/lib/email-verification.ts", "utf8"));
    expect(src).toContain(`source: "${RELEASE_VERIFY_LABEL}"`);
  });

  it("throws on a refused call", async () => {
    vi.mocked(sql).mockResolvedValueOnce(rows(1) as any);
    fetchMock.mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(nameSubscribersAtApollo({ dryRun: true })).rejects.toThrow(/400: nope/);
  });
});
