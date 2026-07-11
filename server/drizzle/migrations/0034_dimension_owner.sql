-- Reference tables get an accountable owner (a workspace member).
ALTER TABLE "zugzug_app"."dimension" ADD COLUMN "owner_user_id" varchar;
