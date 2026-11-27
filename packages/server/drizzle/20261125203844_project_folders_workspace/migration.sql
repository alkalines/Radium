ALTER TABLE "project_folders" DROP CONSTRAINT "project_folders_project_projects_id_fkey";--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN "workspace" text;--> statement-breakpoint
UPDATE "project_folders" SET "workspace" = "projects"."workspace" FROM "projects" WHERE "projects"."id" = "project_folders"."project";--> statement-breakpoint
ALTER TABLE "project_folders" ALTER COLUMN "workspace" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "project_folders_workspace" ON "project_folders" ("workspace");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_id_workspace" ON "projects" ("id","workspace");--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_project_fk" FOREIGN KEY ("project","workspace") REFERENCES "projects"("id","workspace") ON DELETE CASCADE;