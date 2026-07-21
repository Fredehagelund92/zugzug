ALTER TABLE "zugzug_app"."outbound_event" DROP CONSTRAINT "outbound_event_type_chk";--> statement-breakpoint
-- Rename historical rows too — installs with pre-rename events would otherwise
-- violate the new constraint and the migration would abort.
UPDATE "zugzug_app"."outbound_event" SET "type" = CASE "type"
        WHEN 'dimension.committed'      THEN 'table.published'
        WHEN 'dimension.created'        THEN 'table.created'
        WHEN 'dimension.schema.updated' THEN 'table.fields.updated'
        WHEN 'canonical.deleted'        THEN 'record.deleted'
        ELSE "type" END
  WHERE "type" IN ('dimension.committed', 'dimension.created', 'dimension.schema.updated', 'canonical.deleted');--> statement-breakpoint
ALTER TABLE "zugzug_app"."outbound_event" ADD CONSTRAINT "outbound_event_type_chk" CHECK ("zugzug_app"."outbound_event"."type" IN (
        'table.published',
        'table.created',
        'table.fields.updated',
        'record.deleted'
      ));--> statement-breakpoint
ALTER TABLE "zugzug_app"."webhook" DROP CONSTRAINT "webhook_events_known_chk";--> statement-breakpoint
UPDATE "zugzug_app"."webhook" SET "events" =
  array_replace(array_replace(array_replace(array_replace("events",
    'dimension.committed', 'table.published'),
    'dimension.created', 'table.created'),
    'dimension.schema.updated', 'table.fields.updated'),
    'canonical.deleted', 'record.deleted');--> statement-breakpoint
ALTER TABLE "zugzug_app"."webhook" ADD CONSTRAINT "webhook_events_known_chk" CHECK ("zugzug_app"."webhook"."events" <@ ARRAY[
        'table.published',
        'table.created',
        'table.fields.updated',
        'record.deleted'
      ]::varchar[]);
