import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    // The suites share one database: each migrates it on the way in and
    // truncates its own tables between cases. Run them one file at a time.
    // Against an empty database two files migrating at once race on the
    // drizzle schema itself and one of them dies with "duplicate key value
    // violates unique constraint pg_namespace_nspname_index" — invisible
    // while the database was a fork of production, where migrate() had
    // nothing left to create.
    fileParallelism: false,
  },
});
