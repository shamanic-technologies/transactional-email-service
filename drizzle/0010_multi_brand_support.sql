-- Migrate brand_id (single text) to brand_ids (text array) for multi-brand support
ALTER TABLE "email_events" ADD COLUMN IF NOT EXISTS "brand_ids" text[];
UPDATE "email_events" SET "brand_ids" = ARRAY["brand_id"] WHERE "brand_id" IS NOT NULL;
ALTER TABLE "email_events" DROP COLUMN "brand_id";
CREATE INDEX "idx_email_events_brand_ids" ON "email_events" USING gin ("brand_ids");
