import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory mock of chrome.storage.local (ledger uses local, not session).
const localStore: Record<string, unknown> = {};

const mockChrome = {
  storage: {
    local: {
      get: vi.fn(async (key: string | string[]) => {
        if (typeof key === "string") return { [key]: localStore[key] };
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = localStore[k];
          return out;
        }
        return { ...localStore };
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(localStore, obj);
      }),
      remove: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete localStore[k];
      }),
    },
    session: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
};

// @ts-expect-error — stub global
globalThis.chrome = mockChrome;

const {
  appendEntry,
  queryByKey,
  getMonthSpend,
  getDailySpend,
  clearByKey,
  getOriginSummary,
  exportCSV,
  __test,
} = await import("../ledger.js");

function reset() {
  for (const k of Object.keys(localStore)) delete localStore[k];
}

function mkEntry(overrides: Partial<{
  timestamp: number;
  keyId: string;
  origin: string;
  model: string;
  endpoint: "chat" | "responses" | "anthropic";
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  estimatedCostUSD: number;
  actualCostUSD: number;
  status: "success" | "error" | "cancelled";
  errorCode?: string;
}> = {}) {
  return {
    // Use "now" by default so retention-trim (90 days) doesn't drop entries
    // mid-test. Tests that need a specific absolute timestamp supply one.
    timestamp: Date.now(),
    keyId: "k1",
    origin: "https://example.com",
    model: "gpt-5.4-mini",
    endpoint: "chat" as const,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUSD: 0.01,
    actualCostUSD: 0.012,
    status: "success" as const,
    ...overrides,
  };
}

describe("ledger", () => {
  beforeEach(reset);

  describe("appendEntry + queryByKey", () => {
    it("persists and reads back", async () => {
      await appendEntry(mkEntry());
      const list = await queryByKey("k1");
      expect(list).toHaveLength(1);
      expect(list[0].model).toBe("gpt-5.4-mini");
    });

    it("returns empty for an unknown key", async () => {
      const list = await queryByKey("nonexistent");
      expect(list).toEqual([]);
    });

    it("keeps insertion order", async () => {
      const base = Date.now();
      await appendEntry(mkEntry({ timestamp: base + 100 }));
      await appendEntry(mkEntry({ timestamp: base + 200 }));
      await appendEntry(mkEntry({ timestamp: base + 300 }));
      const list = await queryByKey("k1");
      expect(list.map((e) => e.timestamp)).toEqual([base + 100, base + 200, base + 300]);
    });

    it("segregates entries by keyId", async () => {
      await appendEntry(mkEntry({ keyId: "k1" }));
      await appendEntry(mkEntry({ keyId: "k2" }));
      expect(await queryByKey("k1")).toHaveLength(1);
      expect(await queryByKey("k2")).toHaveLength(1);
    });

    it("filters by `since` timestamp", async () => {
      const base = Date.now();
      await appendEntry(mkEntry({ timestamp: base + 100 }));
      await appendEntry(mkEntry({ timestamp: base + 200 }));
      await appendEntry(mkEntry({ timestamp: base + 300 }));
      const list = await queryByKey("k1", base + 200);
      expect(list.map((e) => e.timestamp)).toEqual([base + 200, base + 300]);
    });
  });

  describe("retention trim", () => {
    it("drops entries older than 90 days on read", async () => {
      const now = Date.now();
      const old = now - __test.RETENTION_MS - 1_000;
      const fresh = now - 1_000;
      await appendEntry(mkEntry({ timestamp: old }));
      await appendEntry(mkEntry({ timestamp: fresh }));
      const list = await queryByKey("k1");
      expect(list).toHaveLength(1);
      expect(list[0].timestamp).toBe(fresh);
    });

    it("the trim helper is deterministic", () => {
      const now = 1_000_000;
      const result = __test.trimByRetention(
        [
          { ...mkEntry({ timestamp: now - __test.RETENTION_MS - 1 }) },
          { ...mkEntry({ timestamp: now - 1 }) },
        ],
        now,
      );
      expect(result).toHaveLength(1);
    });
  });

  describe("getMonthSpend", () => {
    it("sums actualCostUSD of successful entries in the target month", async () => {
      const apr = new Date(Date.UTC(2026, 3, 15)).getTime();
      const may = new Date(Date.UTC(2026, 4, 2)).getTime();
      await appendEntry(mkEntry({ timestamp: apr, actualCostUSD: 0.1 }));
      await appendEntry(mkEntry({ timestamp: apr, actualCostUSD: 0.05 }));
      await appendEntry(mkEntry({ timestamp: may, actualCostUSD: 1.0 }));
      expect(await getMonthSpend("k1", "2026-04")).toBeCloseTo(0.15, 5);
      expect(await getMonthSpend("k1", "2026-05")).toBeCloseTo(1.0, 5);
    });

    it("excludes error / cancelled entries from spend", async () => {
      const ts = Date.now();
      await appendEntry(mkEntry({ timestamp: ts, actualCostUSD: 0.5, status: "error" }));
      await appendEntry(mkEntry({ timestamp: ts, actualCostUSD: 0.3, status: "cancelled" }));
      await appendEntry(mkEntry({ timestamp: ts, actualCostUSD: 0.1, status: "success" }));
      expect(await getMonthSpend("k1", __test.isoMonth(new Date(ts)))).toBeCloseTo(0.1, 5);
    });

    it("returns 0 for a month with no activity", async () => {
      expect(await getMonthSpend("k1", "2020-01")).toBe(0);
    });
  });

  describe("getDailySpend", () => {
    it("sums by UTC day", async () => {
      const d1 = new Date(Date.UTC(2026, 3, 15, 5)).getTime();
      const d1Late = new Date(Date.UTC(2026, 3, 15, 23)).getTime();
      const d2 = new Date(Date.UTC(2026, 3, 16, 2)).getTime();
      await appendEntry(mkEntry({ timestamp: d1, actualCostUSD: 0.1 }));
      await appendEntry(mkEntry({ timestamp: d1Late, actualCostUSD: 0.2 }));
      await appendEntry(mkEntry({ timestamp: d2, actualCostUSD: 1.0 }));
      expect(await getDailySpend("k1", "2026-04-15")).toBeCloseTo(0.3, 5);
      expect(await getDailySpend("k1", "2026-04-16")).toBeCloseTo(1.0, 5);
    });
  });

  describe("clearByKey", () => {
    it("drops all entries for the key", async () => {
      await appendEntry(mkEntry({ keyId: "k1" }));
      await appendEntry(mkEntry({ keyId: "k2" }));
      await clearByKey("k1");
      expect(await queryByKey("k1")).toEqual([]);
      expect(await queryByKey("k2")).toHaveLength(1);
    });

    it("no-op on a missing key", async () => {
      await appendEntry(mkEntry({ keyId: "k2" }));
      await clearByKey("k1");
      expect(await queryByKey("k2")).toHaveLength(1);
    });
  });

  describe("getOriginSummary", () => {
    it("aggregates cost per origin, sorted desc", async () => {
      const ts = Date.now();
      await appendEntry(
        mkEntry({ timestamp: ts, origin: "https://a.com", actualCostUSD: 0.1 }),
      );
      await appendEntry(
        mkEntry({ timestamp: ts, origin: "https://a.com", actualCostUSD: 0.2 }),
      );
      await appendEntry(
        mkEntry({ timestamp: ts, origin: "https://b.com", actualCostUSD: 0.5 }),
      );
      const summary = await getOriginSummary("k1");
      expect(summary[0]).toEqual({ origin: "https://b.com", requestCount: 1, totalCostUSD: 0.5 });
      expect(summary[1]).toEqual({
        origin: "https://a.com",
        requestCount: 2,
        totalCostUSD: expect.closeTo(0.3, 5),
      });
    });

    it("ignores non-success entries", async () => {
      await appendEntry(
        mkEntry({ origin: "https://a.com", actualCostUSD: 0.5, status: "error" }),
      );
      await appendEntry(
        mkEntry({ origin: "https://a.com", actualCostUSD: 0.1, status: "success" }),
      );
      const summary = await getOriginSummary("k1");
      expect(summary).toHaveLength(1);
      expect(summary[0].totalCostUSD).toBeCloseTo(0.1, 5);
    });
  });

  describe("exportCSV", () => {
    it("emits header + one row per entry, escapes commas and quotes", async () => {
      await appendEntry(
        mkEntry({
          origin: 'https://weird,"origin".com',
          model: "gpt-5.4-mini",
          inputTokens: 10,
          outputTokens: 5,
          estimatedCostUSD: 0.001,
          actualCostUSD: 0.0012,
        }),
      );
      const csv = await exportCSV("k1");
      const lines = csv.split("\n");
      expect(lines[0]).toContain("timestamp,origin,model");
      expect(lines[1]).toContain('"https://weird,""origin"".com"');
      expect(lines[1]).toContain("gpt-5.4-mini");
      expect(lines[1]).toContain("0.001000");
      expect(lines[1]).toContain("0.001200");
    });

    it("empty ledger yields just the header", async () => {
      const csv = await exportCSV("k-empty");
      expect(csv.split("\n")).toHaveLength(1);
      expect(csv.split("\n")[0]).toContain("timestamp,");
    });
  });

  describe("concurrency", () => {
    it("parallel appends don't drop entries (mutex serializes writes)", async () => {
      // Fire 20 appends simultaneously. Without the lock, the read-modify-write
      // pattern would collapse several into one snapshot and we'd see <20.
      const base = Date.now();
      const promises: Array<Promise<void>> = [];
      for (let i = 0; i < 20; i++) {
        promises.push(appendEntry(mkEntry({ timestamp: base + i })));
      }
      await Promise.all(promises);
      const list = await queryByKey("k1");
      expect(list).toHaveLength(20);
    });
  });
});
