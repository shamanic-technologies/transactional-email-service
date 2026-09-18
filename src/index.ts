import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import healthRoutes from "./routes/health.js";
import sendRoutes from "./routes/send.js";
import statsRoutes from "./routes/stats.js";
import openapiRoutes from "./routes/openapi.js";
import templatesRoutes from "./routes/templates.js";
import transferBrandRoutes from "./routes/transfer-brand.js";
import mailingListsRoutes from "./routes/mailing-lists.js";
import mailingListReleasesRoutes from "./routes/mailing-list-releases.js";
import { seedStaffTemplates } from "./templates/staff-alerts.js";
import { startReleaseWorker, stopReleaseWorker } from "./lib/release-worker.js";
import { db } from "./db/index.js";

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

app.use(healthRoutes);
app.use(sendRoutes);
app.use(statsRoutes);
app.use(templatesRoutes);
app.use(transferBrandRoutes);
app.use(mailingListsRoutes);
app.use(mailingListReleasesRoutes);
app.use(openapiRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(async () => {
      console.log("Migrations complete");
      // One upsert per staff-alert template. Fixed, tiny, and known at build
      // time, so it cannot stretch the boot window; a staff alert that has no
      // template renders nothing, so a failure here fails the boot.
      await seedStaffTemplates();
      console.log("Staff alert templates registered");
      const server = app.listen(Number(PORT), "::", () => {
        console.log(`Transactional email service running on port ${PORT}`);
        // Armed AFTER the port is bound, never before. A mailing-list release
        // is paced by this interval rather than by a cron, because a cron in
        // this fleet declares a cadence it does not deliver and a release's
        // pace is the product. Nothing it does on an idle tick is more than one
        // indexed read returning no rows, and nothing about it depends on the
        // size of any list, so it cannot stretch the boot window or the health
        // check that follows it.
        startReleaseWorker();
      });

      // A redeploy sends SIGTERM. Stopping the worker first lets the slice it
      // is holding settle, so a planned restart loses nobody and repeats
      // nobody; an unplanned kill is accounted for by the stale-claim sweep on
      // the next tick instead.
      const shutdown = (signal: string) => {
        console.log(`[transactional-email-service] ${signal} received, letting the release worker settle`);
        stopReleaseWorker().finally(() => server.close(() => process.exit(0)));
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
    })
    .catch((err) => {
      console.error("Boot failed:", err);
      process.exit(1);
    });
}

export default app;
