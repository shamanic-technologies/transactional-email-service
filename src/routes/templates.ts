import { Router, Request, Response } from "express";
import { requireApiKey, requireIdentityHeaders } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { emailTemplates } from "../db/schema.js";
import { DeployTemplatesRequestSchema } from "../schemas.js";
import { checkTemplateSyntax, describeUnsupportedTags } from "../templates/syntax.js";

const router = Router();

async function deployTemplates(req: Request, res: Response) {
  try {
    const parsed = DeployTemplatesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { templates } = parsed.data;

    // Refuse the WHOLE batch before writing anything when one template uses
    // syntax the renderer would leave raw ({{#x}}…{{/x}} and the like): the
    // caller learns which template and which token, and no half-applied batch
    // is left behind.
    const rejected = templates
      .map((tpl) => ({ name: tpl.name, problems: checkTemplateSyntax(tpl) }))
      .filter((r) => r.problems.length > 0);
    if (rejected.length > 0) {
      const message = rejected.map((r) => describeUnsupportedTags(r.name, r.problems)).join(" ");
      console.error(`[templates] refused registration: ${message}`);
      res.status(422).json({
        error: message,
        code: "unsupported_template_syntax",
        templates: rejected.flatMap((r) => r.problems.map((p) => ({ name: r.name, field: p.field, token: p.token }))),
      });
      return;
    }
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
          ...(tpl.layout ? { layout: tpl.layout } : {}),
          ...(tpl.stream ? { stream: tpl.stream } : {}),
        })
        .onConflictDoUpdate({
          target: [emailTemplates.name],
          // A layout the caller does not name is left as it is: a template set
          // to "none" stays unwrapped through a redeploy that predates the field.
          set: {
            subject: tpl.subject,
            htmlBody: tpl.htmlBody,
            textBody: tpl.textBody,
            fromAddress: tpl.from ?? null,
            ...(tpl.layout ? { layout: tpl.layout } : {}),
            ...(tpl.stream ? { stream: tpl.stream } : {}),
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
}

// Authenticated route — requires identity headers
router.put("/templates", requireApiKey, requireIdentityHeaders, deployTemplates);

// Platform route — API key only, for cold-start template deployment without user session
router.put("/platform-templates", requireApiKey, deployTemplates);

export default router;
