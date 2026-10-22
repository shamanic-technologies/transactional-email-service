-- inbox_placement_below_bar is no longer a staff alert (owner 2026-10-22: "no email in my inbox please"); inbox placement is watched on dashboard v2 Monitoring.
-- The template was upserted on boot from code, so the stored row has to go too. Past email_events rows for it stay as history.
DELETE FROM "email_templates" WHERE "name" = 'inbox_placement_below_bar';
