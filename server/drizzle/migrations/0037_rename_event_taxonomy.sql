ALTER TABLE "zugzug_app"."outbound_event" DROP CONSTRAINT "outbound_event_type_chk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."outbound_event" ADD CONSTRAINT "outbound_event_type_chk" CHECK ("zugzug_app"."outbound_event"."type" IN (
        'table.published',
        'table.created',
        'table.fields.updated',
        'record.deleted'
      ));--> statement-breakpoint
ALTER TABLE "zugzug_app"."webhook" DROP CONSTRAINT "webhook_events_known_chk";--> statement-breakpoint
ALTER TABLE "zugzug_app"."webhook" ADD CONSTRAINT "webhook_events_known_chk" CHECK ("zugzug_app"."webhook"."events" <@ ARRAY[
        'table.published',
        'table.created',
        'table.fields.updated',
        'record.deleted'
      ]::varchar[]);
