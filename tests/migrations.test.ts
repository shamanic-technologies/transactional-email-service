import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const DRIZZLE_DIR = join(__dirname, "..", "drizzle");

describe("migration files", () => {
  const migrationFiles = readdirSync(DRIZZLE_DIR).filter((f) =>
    f.endsWith(".sql")
  );

  it("should have migration files", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it("ADD COLUMN statements should use IF NOT EXISTS for idempotency", () => {
    for (const file of migrationFiles) {
      const content = readFileSync(join(DRIZZLE_DIR, file), "utf-8");
      const lines = content.split("\n");

      for (const line of lines) {
        const trimmed = line.replace(/--> statement-breakpoint$/, "").trim();
        if (/ALTER TABLE.*ADD COLUMN/i.test(trimmed)) {
          expect(trimmed).toMatch(
            /ADD COLUMN IF NOT EXISTS/i,
          );
        }
      }
    }
  });
});
