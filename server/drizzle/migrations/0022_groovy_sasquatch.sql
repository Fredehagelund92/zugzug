ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "ordering_mode" varchar DEFAULT 'derived' NOT NULL;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "last_rebalanced_at" timestamp;--> statement-breakpoint
ALTER TABLE "zugzug_app"."dimension" ADD CONSTRAINT "dimension_ordering_mode_chk" CHECK ("zugzug_app"."dimension"."ordering_mode" IN ('derived', 'manual'));