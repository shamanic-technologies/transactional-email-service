import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { emailTemplates } from "../db/schema.js";
import { DeployTemplatesRequestSchema } from "../schemas.js";

const router = Router();

router.put("/templates", requireApiKey, async (req, res) => {
  try {
    const parsed = DeployTemplatesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { templates } = parsed.data;
    const results: Array<{ name: string; action: "created" | "updated" }> = [];

    for (const tpl of templates) {
      const [row] = await db
        .insert(emailTemplates)
        .values({
          name: tpl.name,
          subject: tpl.subject,
          htmlBody: tpl.htmlBody,
          textBody: tpl.textBody,
          fromAddress: tpl.from ?? null,
        })
        .onConflictDoUpdate({
          target: [emailTemplates.name],
          set: {
            subject: tpl.subject,
            htmlBody: tpl.htmlBody,
            textBody: tpl.textBody,
            fromAddress: tpl.from ?? null,
            updatedAt: new Date(),
          },
        })
        .returning({ createdAt: emailTemplates.createdAt, updatedAt: emailTemplates.updatedAt });

      const action = row.createdAt.getTime() === row.updatedAt.getTime() ? "created" : "updated";
      results.push({ name: tpl.name, action });
    }

    res.json({ templates: results });
  } catch (error: any) {
    console.error("Deploy templates error:", error);
    res.status(500).json({ error: error.message || "Failed to deploy templates" });
  }
});

export default router;
