CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"registration_record" text,
	"opaque_credential_version" text,
	"opaque_key_stretching" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e2ee_identities" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"key_id" text NOT NULL,
	"suite" integer NOT NULL,
	"encryption_public_key" bytea NOT NULL,
	"signing_public_key" bytea NOT NULL,
	"secrets" bytea NOT NULL,
	"self_signature" bytea NOT NULL,
	"recovery_wrapper" bytea NOT NULL,
	"status" text NOT NULL,
	"retired_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_identities_status" CHECK ("status" in ('pending', 'active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "e2ee_key_bundles" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"credential_version" text NOT NULL,
	"identity" text NOT NULL,
	"password_wrapper" bytea NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"dedupe_key" text UNIQUE,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp(6) with time zone,
	"last_error" text,
	"failed_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_keys" (
	"id" text PRIMARY KEY,
	"worker" text NOT NULL,
	"algorithm" text NOT NULL,
	"material" text NOT NULL,
	"thumbprint" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"name" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"status" text NOT NULL,
	"identity_epoch" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workers_status" CHECK ("status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_role" CHECK ("role" in ('member'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"archived_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_identities_key_id" ON "e2ee_identities" ("key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_identities_one_active" ON "e2ee_identities" ("user_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "e2ee_identities_user_status" ON "e2ee_identities" ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_key_bundles_user_version" ON "e2ee_key_bundles" ("user_id","credential_version");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" ("run_at") WHERE "failed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "worker_keys_thumbprint" ON "worker_keys" ("thumbprint");--> statement-breakpoint
CREATE INDEX "worker_keys_worker" ON "worker_keys" ("worker");--> statement-breakpoint
CREATE INDEX "workers_workspace" ON "workers" ("workspace");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_workspace_user" ON "workspace_members" ("workspace","user_id");--> statement-breakpoint
CREATE INDEX "workspace_members_user" ON "workspace_members" ("user_id");--> statement-breakpoint
CREATE INDEX "workspaces_owner" ON "workspaces" ("owner_id");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_identities" ADD CONSTRAINT "e2ee_identities_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_key_bundles" ADD CONSTRAINT "e2ee_key_bundles_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_key_bundles" ADD CONSTRAINT "e2ee_key_bundles_identity_e2ee_identities_id_fkey" FOREIGN KEY ("identity") REFERENCES "e2ee_identities"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "worker_keys" ADD CONSTRAINT "worker_keys_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT;