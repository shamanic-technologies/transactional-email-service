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
import { seedStaffTemplates } from "./templates/staff-alerts.js";
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
      app.listen(Number(PORT), "::", () => {
        console.log(`Transactional email service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Boot failed:", err);
      process.exit(1);
    });
}

export default app;
