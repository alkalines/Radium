CREATE TABLE "acp_agent_sessions" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"workspace" text NOT NULL,
	"worker" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"cwd" text NOT NULL,
	"title" text,
	"sealed_title_epoch" integer,
	"sealed_title_box" bytea,
	"title_tag" text,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"chat" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_agent_sessions_sealed_title" CHECK (num_nonnulls("sealed_title_epoch", "sealed_title_box") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "acp_agents" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"args" text[] NOT NULL,
	"env" jsonb NOT NULL,
	"gateway" jsonb,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"icon" text,
	"version" text,
	"authorization_issued_at" timestamp(6) with time zone,
	"authorization_signer_key_id" text,
	"authorization_signature" bytea,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_agents_source" CHECK ("source" in ('registry', 'custom')),
	CONSTRAINT "acp_agents_authorization" CHECK (num_nonnulls("authorization_issued_at", "authorization_signer_key_id", "authorization_signature") in (0, 3))
);
--> statement-breakpoint
CREATE TABLE "acp_commands" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"worker" text NOT NULL,
	"chat" text,
	"kind" text NOT NULL,
	"agent_id" text,
	"payload" jsonb,
	"signed_payload" bytea,
	"signed_signature" bytea,
	"signed_signer_key_id" text,
	"target" jsonb,
	"client_id" text NOT NULL,
	"issued_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"result" text,
	"claimed_at" timestamp(6) with time zone,
	"finished_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_commands_kind" CHECK ("kind" in ('prompt', 'cancel', 'set_config', 'set_mode', 'history', 'sync_sessions', 'authenticate', 'logout', 'fork', 'close', 'delete')),
	CONSTRAINT "acp_commands_status" CHECK ("status" in ('pending', 'claimed', 'done', 'failed')),
	CONSTRAINT "acp_commands_signed" CHECK (num_nonnulls("signed_payload", "signed_signature", "signed_signer_key_id") in (0, 3)),
	CONSTRAINT "acp_commands_payload" CHECK (num_nonnulls("payload", "signed_payload") = (case when "status" = 'pending' then 1 else 0 end)),
	CONSTRAINT "acp_commands_session_kinds" CHECK (("chat" is not null) = ("kind" in ('prompt', 'cancel', 'set_config', 'set_mode', 'history', 'fork'))),
	CONSTRAINT "acp_commands_claimed_at" CHECK ("status" <> 'claimed' or "claimed_at" is not null),
	CONSTRAINT "acp_commands_finished_at" CHECK (("status" in ('done', 'failed')) = ("finished_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "acp_interactions" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"workspace" text NOT NULL,
	"chat" text NOT NULL,
	"worker" text NOT NULL,
	"request_key" text NOT NULL,
	"kind" text NOT NULL,
	"request" jsonb,
	"sealed_request_epoch" integer,
	"sealed_request_box" bytea,
	"sealed_request_signature" bytea,
	"status" text DEFAULT 'pending' NOT NULL,
	"answer" jsonb,
	"sealed_answer" bytea,
	"sealed_answer_signature" bytea,
	"sealed_answer_signer_key_id" text,
	"answered_by" text,
	"answered_at" timestamp(6) with time zone,
	"resolved_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_interactions_kind" CHECK ("kind" in ('permission', 'elicitation')),
	CONSTRAINT "acp_interactions_status" CHECK ("status" in ('pending', 'answered', 'resolved', 'cancelled')),
	CONSTRAINT "acp_interactions_sealed_request" CHECK (num_nonnulls("sealed_request_epoch", "sealed_request_box", "sealed_request_signature") in (0, 3)),
	CONSTRAINT "acp_interactions_sealed_answer" CHECK (num_nonnulls("sealed_answer", "sealed_answer_signature", "sealed_answer_signer_key_id") in (0, 3)),
	CONSTRAINT "acp_interactions_one_request" CHECK (num_nonnulls("request", "sealed_request_box") <= 1),
	CONSTRAINT "acp_interactions_answer" CHECK (case "status"
        when 'pending' then num_nonnulls("answer", "sealed_answer", "answered_by", "answered_at") = 0
        when 'answered' then num_nonnulls("answer", "sealed_answer") = 1 and "answered_by" is not null and "answered_at" is not null
        else true end),
	CONSTRAINT "acp_interactions_resolved_at" CHECK (("status" in ('resolved', 'cancelled')) = ("resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "acp_sessions" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"chat" text NOT NULL,
	"workspace" text NOT NULL,
	"worker" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"profile" text DEFAULT 'native' NOT NULL,
	"cwd" text NOT NULL,
	"session_id" text,
	"status" text NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"cooled_epoch" integer,
	"stop_reason" text,
	"error" text,
	"config" jsonb,
	"commands" jsonb,
	"usage" jsonb,
	"turn_usage" jsonb,
	"history" text,
	"draft" jsonb,
	"turn_by" text,
	"user_titled" boolean DEFAULT false NOT NULL,
	"binding" jsonb,
	"session_proof" jsonb,
	"sealed_error_epoch" integer,
	"sealed_error_box" bytea,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_sessions_profile" CHECK ("profile" in ('native', 'gateway')),
	CONSTRAINT "acp_sessions_status" CHECK ("status" in ('starting', 'idle', 'running', 'awaiting', 'failed', 'ended')),
	CONSTRAINT "acp_sessions_stop_reason" CHECK ("stop_reason" in ('end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled')),
	CONSTRAINT "acp_sessions_history" CHECK ("history" in ('full', 'resumed', 'none')),
	CONSTRAINT "acp_sessions_epochs" CHECK ("epoch" >= 0 and ("cooled_epoch" is null or "cooled_epoch" <= "epoch")),
	CONSTRAINT "acp_sessions_sealed_error" CHECK (num_nonnulls("sealed_error_epoch", "sealed_error_box") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "chat_files" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"workspace" text NOT NULL,
	"user_id" text NOT NULL,
	"storage_key" text,
	"legacy_url" text,
	"media_type" text NOT NULL,
	"filename" text,
	"size" bigint NOT NULL,
	"chat" text,
	"file_id" text,
	"capsule" bytea,
	"chat_epoch" integer,
	"e2ee_parent" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_files_sealed" CHECK (num_nonnulls("file_id", "capsule", "chat_epoch", "e2ee_parent") in (0, 4))
);
--> statement-breakpoint
CREATE TABLE "chat_mcp_servers" (
	"id" text PRIMARY KEY,
	"chat" text NOT NULL,
	"workspace" text NOT NULL,
	"mcp_server" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_members" (
	"id" text PRIMARY KEY,
	"chat" text NOT NULL,
	"workspace" text NOT NULL,
	"user_id" text NOT NULL,
	"last_interaction_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"chat" text NOT NULL,
	"position" integer NOT NULL,
	"message" jsonb,
	"message_id" text,
	"revision" integer,
	"sealed_capsule_id" text,
	"sealed_envelope" bytea,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_position" CHECK ("position" >= 0),
	CONSTRAINT "chat_messages_sealed" CHECK (num_nonnulls("sealed_capsule_id", "sealed_envelope") in (0, 2)),
	CONSTRAINT "chat_messages_one_form" CHECK (num_nonnulls("message", "sealed_envelope") <= 1)
);
--> statement-breakpoint
CREATE TABLE "chat_runs" (
	"id" text PRIMARY KEY,
	"chat" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"lease_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_runs_status" CHECK ("status" in ('active', 'finished', 'failed')),
	CONSTRAINT "chat_runs_ended_at" CHECK (("status" = 'active') = ("ended_at" is null))
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"user_id" text NOT NULL,
	"workspace" text NOT NULL,
	"scope" text DEFAULT 'personal' NOT NULL,
	"project" text,
	"title" text,
	"emoji" text,
	"pinned_at" timestamp(6) with time zone,
	"last_interaction_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	"messages_queue" jsonb,
	"sealed_queue_epoch" integer,
	"sealed_queue_box" bytea,
	"interruption" jsonb,
	"builtin_tool_sets" text[],
	"disabled_builtin_tool_sets" text[],
	"worker" text,
	"worker_selection" jsonb,
	"e2ee_id" text,
	"key_epoch" integer,
	"rekey" boolean DEFAULT false NOT NULL,
	"sealed_title_epoch" integer,
	"sealed_title_box" bytea,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_id_workspace" UNIQUE("id","workspace"),
	CONSTRAINT "chats_scope" CHECK ("scope" in ('personal', 'shared', 'workspace')),
	CONSTRAINT "chats_sealed_queue" CHECK (num_nonnulls("sealed_queue_epoch", "sealed_queue_box") in (0, 2)),
	CONSTRAINT "chats_sealed_title" CHECK (num_nonnulls("sealed_title_epoch", "sealed_title_box") in (0, 2)),
	CONSTRAINT "chats_e2ee" CHECK (num_nonnulls("e2ee_id", "key_epoch") in (0, 2)),
	CONSTRAINT "chats_tools" CHECK (num_nonnulls("builtin_tool_sets", "disabled_builtin_tool_sets") in (0, 2)),
	CONSTRAINT "chats_worker_selection" CHECK ("worker" is null or "worker_selection" is not null)
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"transport" text NOT NULL,
	"auth" jsonb NOT NULL,
	"preview" jsonb,
	"code_mode" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_workspace_id" UNIQUE("workspace","id"),
	CONSTRAINT "mcp_servers_transport" CHECK ("transport" in ('http'))
);
--> statement-breakpoint
CREATE TABLE "e2ee_capsules" (
	"id" text PRIMARY KEY,
	"chat" text NOT NULL,
	"capsule_id" text NOT NULL,
	"chat_epoch" integer NOT NULL,
	"capsule" bytea NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e2ee_chat_key_wraps" (
	"id" text PRIMARY KEY,
	"chat" text NOT NULL,
	"workspace" text NOT NULL,
	"chat_epoch" integer NOT NULL,
	"recipient" text NOT NULL,
	"user_id" text,
	"workspace_epoch" integer,
	"recipient_key_id" text NOT NULL,
	"sealed" bytea NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_chat_key_wraps_recipient" CHECK ("recipient" in ('workspace', 'identity')),
	CONSTRAINT "e2ee_chat_key_wraps_recipient_target" CHECK (case "recipient" when 'identity' then "user_id" is not null and "workspace_epoch" is null else "user_id" is null and "workspace_epoch" is not null end)
);
--> statement-breakpoint
CREATE TABLE "e2ee_chat_keys" (
	"id" text PRIMARY KEY,
	"chat" text NOT NULL,
	"epoch" integer NOT NULL,
	"key_id" text NOT NULL,
	"suite" integer NOT NULL,
	"public_key" bytea NOT NULL,
	"signer_user_id" text,
	"signer_key_id" text,
	"signature" bytea,
	"binding_signature" bytea,
	"binding_members" text[],
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_chat_keys_epoch" CHECK ("epoch" >= 1),
	CONSTRAINT "e2ee_chat_keys_signer" CHECK (num_nonnulls("signer_user_id", "signer_key_id", "signature") in (0, 3)),
	CONSTRAINT "e2ee_chat_keys_binding" CHECK (("binding_signature" is null or "signature" is not null) and ("binding_members" is null or "binding_signature" is not null))
);
--> statement-breakpoint
CREATE TABLE "e2ee_invites" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"invite_id" text NOT NULL,
	"invited_user_id" text NOT NULL,
	"epoch" integer NOT NULL,
	"sealed" bytea NOT NULL,
	"owner_secret" bytea NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e2ee_join_requests" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"user_id" text NOT NULL,
	"key_id" text NOT NULL,
	"source" text NOT NULL,
	"mac" bytea,
	"owner_secret" bytea,
	"source_id" text,
	"epoch" integer,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_join_requests_source" CHECK ("source" in ('invite', 'phrase', 'request')),
	CONSTRAINT "e2ee_join_requests_proof" CHECK (num_nonnulls("mac", "owner_secret", "source_id", "epoch") = case when "source" = 'request' then 0 else 4 end)
);
--> statement-breakpoint
CREATE TABLE "e2ee_phrases" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"epoch" integer NOT NULL,
	"phrase_id" text NOT NULL,
	"wrapper" bytea NOT NULL,
	"owner_secret" bytea NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e2ee_rosters" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"version" integer NOT NULL,
	"body" bytea NOT NULL,
	"signature" bytea NOT NULL,
	"signer_key_id" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_rosters_version" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "e2ee_trust_stores" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	"envelope" bytea NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_trust_stores_version" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "e2ee_worker_keys" (
	"id" text PRIMARY KEY,
	"worker" text NOT NULL,
	"key_id" text NOT NULL,
	"suite" integer NOT NULL,
	"encryption_public_key" bytea NOT NULL,
	"signing_public_key" bytea NOT NULL,
	"self_signature" bytea NOT NULL,
	"pairing_mac" bytea NOT NULL,
	"pairing_id" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "e2ee_worker_pairings" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"pairing_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"worker" text,
	"enrollment" text,
	"sealed_secret" bytea NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_worker_pairings_target" CHECK (num_nonnulls("worker", "enrollment") >= 1)
);
--> statement-breakpoint
CREATE TABLE "e2ee_workspace_epochs" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"epoch" integer NOT NULL,
	"suite" integer NOT NULL,
	"member_key_id" text NOT NULL,
	"member_public_key" bytea NOT NULL,
	"owner_key_id" text NOT NULL,
	"owner_public_key" bytea NOT NULL,
	"created_by" text NOT NULL,
	"roster_archive_hash" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_workspace_epochs_epoch" CHECK ("epoch" >= 1),
	CONSTRAINT "e2ee_workspace_epochs_distinct_keys" CHECK ("member_key_id" <> "owner_key_id")
);
--> statement-breakpoint
CREATE TABLE "e2ee_workspace_grants" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"epoch" integer NOT NULL,
	"purpose" text NOT NULL,
	"user_id" text NOT NULL,
	"recipient_key_id" text NOT NULL,
	"granter_user_id" text NOT NULL,
	"granter_key_id" text NOT NULL,
	"sealed" bytea NOT NULL,
	"signature" bytea NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e2ee_workspace_grants_purpose" CHECK ("purpose" in ('member', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "ai_apps" (
	"id" text PRIMARY KEY,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"icon" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"preview" text,
	"revoked_at" timestamp(6) with time zone,
	"worker" text,
	"telemetry" text DEFAULT 'workspace' NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_name" CHECK (btrim("name") <> ''),
	CONSTRAINT "api_keys_telemetry" CHECK ("telemetry" in ('workspace', 'off'))
);
--> statement-breakpoint
CREATE TABLE "authors" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_limits" (
	"id" text PRIMARY KEY,
	"credential" text NOT NULL,
	"meters" jsonb DEFAULT '[]' NOT NULL,
	"plan" text,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"passive_at" timestamp(6) with time zone,
	"polled_at" timestamp(6) with time zone,
	"poll_attempt_at" timestamp(6) with time zone,
	"next_poll_at" timestamp(6) with time zone,
	"poll_error_message" text,
	"poll_error_status" integer,
	"poll_error_at" timestamp(6) with time zone,
	"poll_failures" integer DEFAULT 0 NOT NULL,
	"alerts" jsonb DEFAULT '[]' NOT NULL,
	"expired_at" timestamp(6) with time zone,
	"budget_resets_at" timestamp(6) with time zone,
	"budget_pending_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_limits_poll_error" CHECK (num_nonnulls("poll_error_message", "poll_error_at") in (0, 2) and ("poll_error_status" is null or "poll_error_message" is not null)),
	CONSTRAINT "credential_limits_poll_failures" CHECK ("poll_failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE "limit_events" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_name" text NOT NULL,
	"credential" text,
	"credential_name" text NOT NULL,
	"meter" jsonb,
	"previous" jsonb,
	"threshold" double precision,
	"status" integer,
	"message" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"settings_warn_percent" double precision NOT NULL,
	"settings_critical_percent" double precision NOT NULL,
	"settings_low_balance" double precision NOT NULL,
	"occurred_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "limit_events_kind" CHECK ("kind" in ('limit_low', 'limit_critical', 'limit_exhausted', 'limit_reset', 'credential_expired', 'credential_restored', 'poll_failed'))
);
--> statement-breakpoint
CREATE TABLE "models" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"launch_date" timestamp(6) with time zone NOT NULL,
	"author" text NOT NULL,
	"slug" text NOT NULL,
	"model_weights" text,
	"type" text NOT NULL,
	"description" text NOT NULL,
	"warning" text,
	"reasoning" boolean NOT NULL,
	"features_reasoning_minimal" boolean,
	"features_reasoning_none" boolean,
	"features_reasoning_budget" boolean,
	"features_reasoning_efforts" text[],
	"architecture" jsonb NOT NULL,
	"default_temperature" double precision,
	"default_top_p" double precision,
	"default_frequency_penalty" double precision,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "models_type" CHECK ("type" in ('chat', 'embedding', 'image-generation'))
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"npm" text NOT NULL,
	"env" text[] NOT NULL,
	"catalogue_provider" text,
	"credential_type" text,
	"oauth_flow" text,
	"doc" text,
	"api" text,
	"enabled" boolean NOT NULL,
	"models" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "providers_npm" CHECK ("npm" in ('@openrouter/ai-sdk-provider', '@ai-sdk/openai', '@ai-sdk/openai-compatible', '@ai-sdk/anthropic', '@opencoredev/loginwithchatgpt-ai')),
	CONSTRAINT "providers_credential_type" CHECK ("credential_type" in ('api_key', 'oauth'))
);
--> statement-breakpoint
CREATE TABLE "secret_events" (
	"id" text PRIMARY KEY,
	"secret" text,
	"namespace" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_events_type" CHECK ("type" in ('created', 'updated', 'deleted', 'rotated'))
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" text PRIMARY KEY,
	"namespace" text,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"iv" text NOT NULL,
	"wrapped_dek" text NOT NULL,
	"dek_iv" text NOT NULL,
	"key_version" integer NOT NULL,
	"metadata" jsonb,
	"expires_at" timestamp(6) with time zone,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_namespace_name" UNIQUE NULLS NOT DISTINCT("namespace","name"),
	CONSTRAINT "secrets_namespace" CHECK ("namespace" is null or "namespace" <> ''),
	CONSTRAINT "secrets_name" CHECK (btrim("name") <> '')
);
--> statement-breakpoint
CREATE TABLE "subscription_sessions" (
	"id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_credentials" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"provider" text NOT NULL,
	"preview" jsonb NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"secret_name" text,
	"account" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"budget_amount" double precision,
	"budget_period" text,
	"limit_key_preview" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_credentials_weight" CHECK ("weight" >= 0),
	CONSTRAINT "workspace_credentials_budget_set" CHECK (num_nonnulls("budget_amount", "budget_period") in (0, 2)),
	CONSTRAINT "workspace_credentials_budget_amount" CHECK ("budget_amount" is null or "budget_amount" > 0),
	CONSTRAINT "workspace_credentials_budget_period" CHECK ("budget_period" in ('day', 'week', 'month'))
);
--> statement-breakpoint
CREATE TABLE "workspace_providers" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean NOT NULL,
	"active" boolean NOT NULL,
	"snapshot" jsonb,
	"deleted_at" timestamp(6) with time zone,
	"routing" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_providers_tombstone" CHECK ("deleted_at" is null or (not "enabled" and not "active"))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"user_id" text NOT NULL,
	"workspace" text,
	"kind" text NOT NULL,
	"chat" text,
	"limit_event" text,
	"sealed_key_id" text,
	"sealed_box" bytea,
	"seen_at" timestamp(6) with time zone,
	"delivery_channel" text,
	"delivery_at" timestamp(6) with time zone,
	"delivery_devices" integer,
	"delivery_delivered" integer,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind" CHECK ("kind" in ('session_finished', 'session_approval', 'session_question', 'session_failed', 'limit_low', 'limit_critical', 'limit_exhausted', 'limit_reset', 'credential_expired', 'credential_restored', 'poll_failed')),
	CONSTRAINT "notifications_delivery_channel" CHECK ("delivery_channel" in ('web_push')),
	CONSTRAINT "notifications_subject" CHECK (("kind" in ('session_finished', 'session_approval', 'session_question', 'session_failed') and "chat" is not null and "limit_event" is null)
        or ("kind" not in ('session_finished', 'session_approval', 'session_question', 'session_failed') and "chat" is null and "limit_event" is not null)),
	CONSTRAINT "notifications_sealed" CHECK (num_nonnulls("sealed_key_id", "sealed_box") in (0, 2)),
	CONSTRAINT "notifications_sealed_legacy" CHECK ("sealed_box" is null or "legacy_content" is null),
	CONSTRAINT "notifications_delivery" CHECK (num_nonnulls("delivery_channel", "delivery_at", "delivery_devices") in (0, 3)
        and ("delivery_delivered" is null or "delivery_channel" is not null)),
	CONSTRAINT "notifications_claim_or_delivery" CHECK ("seen_at" is null or "delivery_at" is null)
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"label" text NOT NULL,
	"last_delivered_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_https" CHECK ("endpoint" ~* '^https://')
);
--> statement-breakpoint
CREATE TABLE "telemetry_blobs" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"workspace" text NOT NULL,
	"hash" text NOT NULL,
	"kind" text NOT NULL,
	"size" bigint NOT NULL,
	"content" text,
	"storage_key" text,
	"meta" jsonb,
	"sealed_epoch" integer,
	"sealed_request_id" text,
	"sealed_capsule" bytea,
	"sealed_envelope" bytea,
	"truncated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_blobs_kind" CHECK ("kind" in ('message', 'system', 'tool', 'toolset', 'params', 'headers', 'legacy')),
	CONSTRAINT "telemetry_blobs_size" CHECK ("size" >= 0),
	CONSTRAINT "telemetry_blobs_sealed" CHECK (num_nonnulls("sealed_epoch", "sealed_request_id", "sealed_capsule") in (0, 3)),
	CONSTRAINT "telemetry_blobs_sealed_envelope" CHECK ("sealed_envelope" is null or ("sealed_epoch" is not null and "storage_key" is null)),
	CONSTRAINT "telemetry_blobs_content_source" CHECK ("content" is null or num_nonnulls("storage_key", "sealed_epoch", "legacy_content") = 0)
);
--> statement-breakpoint
CREATE TABLE "telemetry_destinations" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"secret_name" text,
	"enabled" boolean NOT NULL,
	"privacy_mode" boolean NOT NULL,
	"sampling_rate" double precision NOT NULL,
	"include_api_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"exclude_api_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_delivery_at" timestamp(6) with time zone,
	"last_error" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_destinations_kind" CHECK ("kind" in ('otlp', 'webhook')),
	CONSTRAINT "telemetry_destinations_sampling_rate" CHECK ("sampling_rate" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "telemetry_nodes" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"workspace" text NOT NULL,
	"hash" text NOT NULL,
	"parent" text,
	"blob" text NOT NULL,
	"depth" integer NOT NULL,
	"origin" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_nodes_origin" CHECK ("origin" in ('input', 'output')),
	CONSTRAINT "telemetry_nodes_depth" CHECK (("parent" is null) = ("depth" = 1))
);
--> statement-breakpoint
CREATE TABLE "telemetry_requests" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"workspace" text NOT NULL,
	"request_id" text NOT NULL,
	"source" text NOT NULL,
	"api_key" text,
	"user_id" text,
	"chat" text,
	"session" text,
	"model" text NOT NULL,
	"provider" text,
	"credential" text,
	"stream" boolean NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp(6) with time zone NOT NULL,
	"ended_at" timestamp(6) with time zone NOT NULL,
	"duration_ms" double precision NOT NULL,
	"ttft_ms" double precision,
	"generation_ms" double precision,
	"finish_reason" text,
	"usage" jsonb,
	"requested_service_tier" text,
	"served_service_tier" text,
	"estimated_cost" double precision,
	"reported_cost" double precision,
	"upstream_inference_cost" double precision,
	"provider_generation_id" text,
	"chat_completion" text,
	"error_message" text,
	"error_status" integer,
	"sealed_error_epoch" integer,
	"sealed_error_request_id" text,
	"sealed_error_capsule" bytea,
	"sealed_error_envelope" bytea,
	"canceled" boolean DEFAULT false NOT NULL,
	"attempts" jsonb NOT NULL,
	"input" text,
	"output" text,
	"system" text,
	"toolset" text,
	"params" text,
	"headers" text,
	"records_inputs" boolean NOT NULL,
	"records_outputs" boolean NOT NULL,
	"lineage" jsonb NOT NULL,
	"changes" jsonb,
	"legacy_trace_id" text,
	"legacy_input" text,
	"legacy_output" text,
	"legacy_spans" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_requests_source" CHECK ("source" in ('chatroom', 'gateway')),
	CONSTRAINT "telemetry_requests_status" CHECK ("status" in ('ok', 'error', 'aborted')),
	CONSTRAINT "telemetry_requests_gateway_no_chat" CHECK ("source" <> 'gateway' or "chat" is null),
	CONSTRAINT "telemetry_requests_error" CHECK ("error_status" is null or "error_message" is not null),
	CONSTRAINT "telemetry_requests_sealed_error" CHECK (num_nonnulls("sealed_error_epoch", "sealed_error_request_id", "sealed_error_capsule", "sealed_error_envelope") in (0, 4)),
	CONSTRAINT "telemetry_requests_legacy" CHECK ("legacy_trace_id" is not null or num_nonnulls("legacy_input", "legacy_output", "legacy_spans") = 0)
);
--> statement-breakpoint
CREATE TABLE "telemetry_sessions" (
	"id" text PRIMARY KEY,
	"legacy_content" jsonb,
	"workspace" text NOT NULL,
	"key" text NOT NULL,
	"parent_key" text,
	"chat" text,
	"source" text NOT NULL,
	"started_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_sessions_source" CHECK ("source" in ('chatroom', 'gateway')),
	CONSTRAINT "telemetry_sessions_gateway_no_chat" CHECK ("source" <> 'gateway' or "chat" is null)
);
--> statement-breakpoint
CREATE TABLE "telemetry_toolset_tools" (
	"id" text PRIMARY KEY,
	"toolset" text NOT NULL,
	"tool" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telemetry_toolset_tools_position" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "acp_model_prices" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"agent_id" text NOT NULL,
	"model" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"queued" boolean NOT NULL,
	"checked_at" timestamp(6) with time zone,
	"match" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_model_prices_checked" CHECK ("queued" or "checked_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "acp_usage" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"chat" text NOT NULL,
	"worker" text NOT NULL,
	"agent_id" text NOT NULL,
	"command" text NOT NULL,
	"user_id" text,
	"started_at" timestamp(6) with time zone NOT NULL,
	"ended_at" timestamp(6) with time zone NOT NULL,
	"stop_reason" text,
	"model_id" text,
	"model_name" text,
	"model_description" text,
	"tokens" jsonb,
	"agent_cost_amount" double precision,
	"agent_cost_currency" text,
	"pricing" jsonb NOT NULL,
	"price_key" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acp_usage_stop_reason" CHECK ("stop_reason" in ('end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled')),
	CONSTRAINT "acp_usage_model" CHECK (num_nonnulls("model_id", "model_name") in (0, 2)),
	CONSTRAINT "acp_usage_model_description" CHECK ("model_description" is null or "model_id" is not null),
	CONSTRAINT "acp_usage_agent_cost" CHECK (num_nonnulls("agent_cost_amount", "agent_cost_currency") in (0, 2) and "agent_cost_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "chat_completions" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"chat" text,
	"user_id" text,
	"client_session" text,
	"api_key" text,
	"provider" text NOT NULL,
	"credential" text,
	"byok" boolean NOT NULL,
	"app" text,
	"model" text NOT NULL,
	"streamed" boolean NOT NULL,
	"canceled" boolean NOT NULL,
	"requested_service_tier" text,
	"inference_mode" text,
	"quote_source" text,
	"quote" jsonb,
	"gen_id" text NOT NULL,
	"provider_gen_id" text NOT NULL,
	"prompt_tokens" bigint NOT NULL,
	"completion_tokens" bigint NOT NULL,
	"usage_details" jsonb NOT NULL,
	"cost" double precision,
	"estimated_cost" double precision,
	"reported_cost" double precision,
	"pricing_details" jsonb NOT NULL,
	"moderation_latency" double precision,
	"ttft" double precision NOT NULL,
	"gen_time" double precision NOT NULL,
	"finish_reason" text NOT NULL,
	"served_service_tier" text,
	"served_quote" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_completions_tokens" CHECK ("prompt_tokens" >= 0 and "completion_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "local_usage" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"worker" text NOT NULL,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"day" date NOT NULL,
	"synced_at" timestamp(6) with time zone NOT NULL,
	"last_activity" timestamp(6) with time zone NOT NULL,
	"total_tokens" bigint NOT NULL,
	"models" jsonb NOT NULL,
	"price_key" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_usage_total_tokens" CHECK ("total_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "local_usage_syncs" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"worker" text NOT NULL,
	"synced_through" date,
	"last_sync_at" timestamp(6) with time zone NOT NULL,
	"error" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_agents" (
	"id" text PRIMARY KEY,
	"worker" text NOT NULL,
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"icon" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"capabilities" jsonb NOT NULL,
	"auth_methods" jsonb NOT NULL,
	"defaults" jsonb,
	"sessions_sync" jsonb,
	"checked_at" timestamp(6) with time zone NOT NULL,
	"legacy_content" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_agents_source" CHECK ("source" in ('registry', 'custom')),
	CONSTRAINT "worker_agents_status" CHECK ("status" in ('ready', 'needs_auth', 'unavailable', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "worker_chat_calls" (
	"id" text PRIMARY KEY,
	"chat" text NOT NULL,
	"user_id" text NOT NULL,
	"worker" text NOT NULL,
	"directory" text NOT NULL,
	"tool" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"stage" text NOT NULL,
	"request_key" text NOT NULL,
	"task" text,
	"result" jsonb,
	"sealed_result" bytea,
	"receipt_epoch" integer,
	"completion_claim_id" text,
	"completion_revision" integer,
	"legacy_content" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_chat_calls_tool" CHECK ("tool" in ('read', 'edit', 'create', 'bash')),
	CONSTRAINT "worker_chat_calls_stage" CHECK ("stage" in ('read', 'preview', 'apply', 'execute')),
	CONSTRAINT "worker_chat_calls_completion" CHECK (num_nonnulls("completion_claim_id", "completion_revision") in (0, 2))
);
--> statement-breakpoint
CREATE TABLE "worker_enrollments" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"token_hash" text NOT NULL,
	"name" text NOT NULL,
	"capabilities" text[] NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"state" text NOT NULL,
	"completion_worker" text,
	"completion_key" text,
	"completion_request_id" text,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_enrollments_state" CHECK ("state" in ('pending', 'completed', 'revoked')),
	CONSTRAINT "worker_enrollments_completion" CHECK (num_nonnulls("completion_worker", "completion_key", "completion_request_id") = case when "state" = 'completed' then 3 else 0 end)
);
--> statement-breakpoint
CREATE TABLE "worker_gateway" (
	"id" text PRIMARY KEY,
	"worker" text NOT NULL,
	"access" text NOT NULL,
	"telemetry" text NOT NULL,
	"api_key" text,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_gateway_access" CHECK ("access" in ('off', 'pending', 'active', 'missing')),
	CONSTRAINT "worker_gateway_telemetry" CHECK ("telemetry" in ('workspace', 'off')),
	CONSTRAINT "worker_gateway_active_key" CHECK (("access" = 'active') = ("api_key" is not null))
);
--> statement-breakpoint
CREATE TABLE "worker_tasks" (
	"id" text PRIMARY KEY,
	"worker" text NOT NULL,
	"request_id" text NOT NULL,
	"operation" text NOT NULL,
	"chat" text,
	"tool_call_id" text,
	"status" text NOT NULL,
	"revision" integer NOT NULL,
	"attempt" integer NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	"terminal_at" timestamp(6) with time zone,
	"edit_request" jsonb,
	"bash_request" jsonb,
	"sealed_key_id" text,
	"sealed_encapsulated" bytea,
	"sealed_request" bytea,
	"edit_owner_id" text,
	"claim_id" text,
	"result" jsonb,
	"sealed_result" bytea,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_tasks_status" CHECK ("status" in ('sent', 'processing', 'failed', 'retrying', 'success')),
	CONSTRAINT "worker_tasks_terminal_at" CHECK (("status" in ('failed', 'success')) = ("terminal_at" is not null)),
	CONSTRAINT "worker_tasks_sealed" CHECK (num_nonnulls("sealed_key_id", "sealed_encapsulated", "sealed_request") in (0, 3)),
	CONSTRAINT "worker_tasks_one_request" CHECK (num_nonnulls("edit_request", "bash_request", "sealed_request") <= 1)
);
--> statement-breakpoint
CREATE TABLE "project_folders" (
	"id" text PRIMARY KEY,
	"project" text NOT NULL,
	"worker" text NOT NULL,
	"directory" text NOT NULL,
	"position" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_folders_directory" CHECK ("directory" <> ''),
	CONSTRAINT "project_folders_position" CHECK ("position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"icon" text,
	"legacy_content" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" text PRIMARY KEY,
	"user_id" text NOT NULL,
	"pinned_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"hidden_models" text[] DEFAULT '{}'::text[] NOT NULL,
	"notifications" jsonb,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_mcp_servers" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"mcp_server" text NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"id" text PRIMARY KEY,
	"workspace" text NOT NULL,
	"default_model" text,
	"title_model" text,
	"enable_chain_of_thought" boolean DEFAULT true NOT NULL,
	"telemetry_enabled" boolean DEFAULT false NOT NULL,
	"telemetry_record_inputs" boolean DEFAULT false NOT NULL,
	"telemetry_record_outputs" boolean DEFAULT false NOT NULL,
	"telemetry_retention_days" integer,
	"builtin_tool_sets" text[] DEFAULT '{}'::text[] NOT NULL,
	"disabled_builtin_tool_sets" text[] DEFAULT '{}'::text[] NOT NULL,
	"worker_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"limits" jsonb,
	"system_prompt_enabled" boolean DEFAULT true NOT NULL,
	"system_prompt_model_identity" boolean DEFAULT true NOT NULL,
	"created_at" timestamp(6) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_settings_telemetry_content" CHECK ("telemetry_enabled" or not ("telemetry_record_inputs" or "telemetry_record_outputs")),
	CONSTRAINT "workspace_settings_telemetry_retention" CHECK ("telemetry_retention_days" is null or "telemetry_retention_days" >= 1),
	CONSTRAINT "workspace_settings_worker_tools" CHECK ("worker_tools" <@ array['read', 'edit', 'create', 'bash']::text[])
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "key_epoch" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "legacy_content" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_id_workspace" UNIQUE("id","workspace");--> statement-breakpoint
CREATE UNIQUE INDEX "acp_agent_sessions_worker_session" ON "acp_agent_sessions" ("worker","agent_id","session_id");--> statement-breakpoint
CREATE INDEX "acp_agent_sessions_agent_recent" ON "acp_agent_sessions" ("workspace","agent_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "acp_agent_sessions_unopened" ON "acp_agent_sessions" ("workspace","updated_at","id") WHERE "chat" is null;--> statement-breakpoint
CREATE INDEX "acp_agent_sessions_unopened_folder" ON "acp_agent_sessions" ("worker","cwd","updated_at","id") WHERE "chat" is null;--> statement-breakpoint
CREATE INDEX "acp_agent_sessions_session" ON "acp_agent_sessions" ("workspace","session_id");--> statement-breakpoint
CREATE INDEX "acp_agent_sessions_chat" ON "acp_agent_sessions" ("chat") WHERE "chat" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "acp_agents_workspace_agent" ON "acp_agents" ("workspace","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "acp_commands_worker_client" ON "acp_commands" ("worker","client_id");--> statement-breakpoint
CREATE INDEX "acp_commands_worker_open" ON "acp_commands" ("worker","status","created_at","id") WHERE "status" in ('pending', 'claimed');--> statement-breakpoint
CREATE INDEX "acp_commands_chat" ON "acp_commands" ("chat","status") WHERE "chat" is not null;--> statement-breakpoint
CREATE INDEX "acp_commands_finished" ON "acp_commands" ("finished_at") WHERE "finished_at" is not null;--> statement-breakpoint
CREATE INDEX "acp_commands_pending_expiry" ON "acp_commands" ("created_at") WHERE "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "acp_interactions_chat_request" ON "acp_interactions" ("chat","request_key");--> statement-breakpoint
CREATE INDEX "acp_interactions_worker_open" ON "acp_interactions" ("worker","status") WHERE "status" in ('pending', 'answered');--> statement-breakpoint
CREATE INDEX "acp_interactions_resolved" ON "acp_interactions" ("resolved_at") WHERE "resolved_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "acp_sessions_chat" ON "acp_sessions" ("chat");--> statement-breakpoint
CREATE UNIQUE INDEX "acp_sessions_binding" ON "acp_sessions" ("worker","agent_id","session_id") WHERE "session_id" is not null;--> statement-breakpoint
CREATE INDEX "acp_sessions_worker_busy" ON "acp_sessions" ("worker","status") WHERE "status" in ('starting', 'running', 'awaiting');--> statement-breakpoint
CREATE INDEX "acp_sessions_session" ON "acp_sessions" ("workspace","session_id") WHERE "session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_files_storage_chat" ON "chat_files" ("storage_key",coalesce("chat", '')) WHERE "storage_key" is not null;--> statement-breakpoint
CREATE INDEX "chat_files_legacy_url" ON "chat_files" ("workspace","legacy_url","chat") WHERE "legacy_url" is not null;--> statement-breakpoint
CREATE INDEX "chat_files_chat" ON "chat_files" ("chat") WHERE "chat" is not null;--> statement-breakpoint
CREATE INDEX "chat_files_pending" ON "chat_files" ("created_at") WHERE "chat" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_mcp_servers_chat_server" ON "chat_mcp_servers" ("chat","mcp_server");--> statement-breakpoint
CREATE INDEX "chat_mcp_servers_server" ON "chat_mcp_servers" ("workspace","mcp_server");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_members_chat_user" ON "chat_members" ("chat","user_id");--> statement-breakpoint
CREATE INDEX "chat_members_user_recent" ON "chat_members" ("workspace","user_id","last_interaction_at","chat");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_chat_position" ON "chat_messages" ("chat","position");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_runs_one_active" ON "chat_runs" ("chat") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "chat_runs_chat" ON "chat_runs" ("chat");--> statement-breakpoint
CREATE INDEX "chat_runs_lease" ON "chat_runs" ("lease_at") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "chats_e2ee_id" ON "chats" ("e2ee_id");--> statement-breakpoint
CREATE INDEX "chats_owner_recent" ON "chats" ("workspace","user_id","last_interaction_at","id");--> statement-breakpoint
CREATE INDEX "chats_workspace_recent" ON "chats" ("workspace","last_interaction_at","id") WHERE "scope" = 'workspace';--> statement-breakpoint
CREATE INDEX "chats_owner_pinned" ON "chats" ("workspace","user_id","pinned_at") WHERE "pinned_at" is not null;--> statement-breakpoint
CREATE INDEX "chats_workspace_pinned" ON "chats" ("workspace","pinned_at") WHERE "scope" = 'workspace' and "pinned_at" is not null;--> statement-breakpoint
CREATE INDEX "chats_project_recent" ON "chats" ("project","last_interaction_at","id") WHERE "project" is not null;--> statement-breakpoint
CREATE INDEX "chats_worker" ON "chats" ("worker") WHERE "worker" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_capsules_chat_capsule" ON "e2ee_capsules" ("chat","capsule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_chat_key_wraps_chat_epoch_recipient" ON "e2ee_chat_key_wraps" ("chat","chat_epoch","recipient_key_id");--> statement-breakpoint
CREATE INDEX "e2ee_chat_key_wraps_chat_workspace_epoch" ON "e2ee_chat_key_wraps" ("chat","chat_epoch","workspace_epoch") WHERE "workspace_epoch" is not null;--> statement-breakpoint
CREATE INDEX "e2ee_chat_key_wraps_workspace_epoch" ON "e2ee_chat_key_wraps" ("workspace","workspace_epoch") WHERE "workspace_epoch" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_chat_keys_chat_epoch" ON "e2ee_chat_keys" ("chat","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_invites_invite_id" ON "e2ee_invites" ("invite_id");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_invites_workspace_user" ON "e2ee_invites" ("workspace","invited_user_id");--> statement-breakpoint
CREATE INDEX "e2ee_invites_expires_at" ON "e2ee_invites" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_join_requests_workspace_user_key" ON "e2ee_join_requests" ("workspace","user_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_phrases_workspace_epoch" ON "e2ee_phrases" ("workspace","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_rosters_workspace_version" ON "e2ee_rosters" ("workspace","version");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_trust_stores_user" ON "e2ee_trust_stores" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_worker_keys_worker" ON "e2ee_worker_keys" ("worker");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_worker_pairings_workspace_pairing" ON "e2ee_worker_pairings" ("workspace","pairing_id");--> statement-breakpoint
CREATE INDEX "e2ee_worker_pairings_expires_at" ON "e2ee_worker_pairings" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_workspace_epochs_workspace_epoch" ON "e2ee_workspace_epochs" ("workspace","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "e2ee_workspace_grants_recipient" ON "e2ee_workspace_grants" ("workspace","user_id","epoch","purpose");--> statement-breakpoint
CREATE INDEX "e2ee_workspace_grants_workspace_epoch" ON "e2ee_workspace_grants" ("workspace","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash" ON "api_keys" ("hash");--> statement-breakpoint
CREATE INDEX "api_keys_workspace" ON "api_keys" ("workspace","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_worker_active" ON "api_keys" ("worker") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "authors_slug" ON "authors" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_limits_credential" ON "credential_limits" ("credential");--> statement-breakpoint
CREATE INDEX "credential_limits_next_poll" ON "credential_limits" ("next_poll_at") WHERE "next_poll_at" is not null;--> statement-breakpoint
CREATE INDEX "credential_limits_budget_resets" ON "credential_limits" ("budget_resets_at") WHERE "budget_resets_at" is not null;--> statement-breakpoint
CREATE INDEX "limit_events_workspace_occurred" ON "limit_events" ("workspace","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "limit_events_occurred" ON "limit_events" ("occurred_at");--> statement-breakpoint
CREATE INDEX "limit_events_credential" ON "limit_events" ("credential") WHERE "credential" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "models_slug" ON "models" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_slug" ON "providers" ("slug");--> statement-breakpoint
CREATE INDEX "secret_events_secret" ON "secret_events" ("secret") WHERE "secret" is not null;--> statement-breakpoint
CREATE INDEX "secrets_key_version" ON "secrets" ("key_version");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_sessions_provider_key" ON "subscription_sessions" ("provider","key");--> statement-breakpoint
CREATE INDEX "workspace_credentials_workspace_provider" ON "workspace_credentials" ("workspace","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_credentials_secret" ON "workspace_credentials" ("workspace","provider","secret_name") WHERE "secret_name" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_credentials_account" ON "workspace_credentials" ("workspace","provider","account") WHERE "account" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_providers_workspace_provider" ON "workspace_providers" ("workspace","provider");--> statement-breakpoint
CREATE INDEX "notifications_user_created" ON "notifications" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_created" ON "notifications" ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_chat" ON "notifications" ("chat") WHERE "chat" is not null;--> statement-breakpoint
CREATE INDEX "notifications_limit_event" ON "notifications" ("limit_event") WHERE "limit_event" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "push_subscriptions_endpoint" ON "push_subscriptions" ("endpoint");--> statement-breakpoint
CREATE INDEX "push_subscriptions_user" ON "push_subscriptions" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_blobs_workspace_hash" ON "telemetry_blobs" ("workspace","hash");--> statement-breakpoint
CREATE INDEX "telemetry_destinations_workspace" ON "telemetry_destinations" ("workspace");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_nodes_workspace_hash" ON "telemetry_nodes" ("workspace","hash");--> statement-breakpoint
CREATE INDEX "telemetry_nodes_parent" ON "telemetry_nodes" ("parent") WHERE "parent" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_nodes_blob" ON "telemetry_nodes" ("blob");--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_requests_workspace_request" ON "telemetry_requests" ("workspace","request_id");--> statement-breakpoint
CREATE INDEX "telemetry_requests_workspace_started" ON "telemetry_requests" ("workspace","started_at");--> statement-breakpoint
CREATE INDEX "telemetry_requests_session_started" ON "telemetry_requests" ("session","started_at") WHERE "session" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_chat" ON "telemetry_requests" ("chat") WHERE "chat" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_credential" ON "telemetry_requests" ("credential") WHERE "credential" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_input" ON "telemetry_requests" ("input","created_at") WHERE "input" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_output" ON "telemetry_requests" ("output","created_at") WHERE "output" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_system" ON "telemetry_requests" ("system") WHERE "system" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_toolset" ON "telemetry_requests" ("toolset") WHERE "toolset" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_params" ON "telemetry_requests" ("params") WHERE "params" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_headers" ON "telemetry_requests" ("headers") WHERE "headers" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_legacy_input" ON "telemetry_requests" ("legacy_input") WHERE "legacy_input" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_legacy_output" ON "telemetry_requests" ("legacy_output") WHERE "legacy_output" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_requests_legacy_spans" ON "telemetry_requests" ("legacy_spans") WHERE "legacy_spans" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_sessions_workspace_key" ON "telemetry_sessions" ("workspace","key");--> statement-breakpoint
CREATE INDEX "telemetry_sessions_workspace_started" ON "telemetry_sessions" ("workspace","started_at");--> statement-breakpoint
CREATE INDEX "telemetry_sessions_workspace_parent_key" ON "telemetry_sessions" ("workspace","parent_key") WHERE "parent_key" is not null;--> statement-breakpoint
CREATE INDEX "telemetry_sessions_chat" ON "telemetry_sessions" ("chat") WHERE "chat" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "telemetry_toolset_tools_toolset_position" ON "telemetry_toolset_tools" ("toolset","position");--> statement-breakpoint
CREATE INDEX "telemetry_toolset_tools_tool" ON "telemetry_toolset_tools" ("tool");--> statement-breakpoint
CREATE UNIQUE INDEX "acp_model_prices_workspace_agent_model" ON "acp_model_prices" ("workspace","agent_id","model");--> statement-breakpoint
CREATE INDEX "acp_model_prices_queued" ON "acp_model_prices" ("created_at") WHERE "queued";--> statement-breakpoint
CREATE UNIQUE INDEX "acp_usage_chat_command" ON "acp_usage" ("chat","command");--> statement-breakpoint
CREATE INDEX "acp_usage_workspace_created" ON "acp_usage" ("workspace","created_at");--> statement-breakpoint
CREATE INDEX "acp_usage_price_key" ON "acp_usage" ("price_key") WHERE "price_key" is not null;--> statement-breakpoint
CREATE INDEX "chat_completions_workspace_created" ON "chat_completions" ("workspace","created_at");--> statement-breakpoint
CREATE INDEX "chat_completions_credential_created" ON "chat_completions" ("credential","created_at") WHERE "credential" is not null;--> statement-breakpoint
CREATE INDEX "chat_completions_chat_created" ON "chat_completions" ("chat","created_at") WHERE "chat" is not null;--> statement-breakpoint
CREATE INDEX "chat_completions_workspace_client_session" ON "chat_completions" ("workspace","client_session","created_at") WHERE "client_session" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "local_usage_worker_session_day_agent" ON "local_usage" ("worker","session_id","day","agent");--> statement-breakpoint
CREATE INDEX "local_usage_workspace_day" ON "local_usage" ("workspace","day");--> statement-breakpoint
CREATE INDEX "local_usage_price_key" ON "local_usage" ("price_key") WHERE "price_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "local_usage_syncs_worker" ON "local_usage_syncs" ("worker");--> statement-breakpoint
CREATE INDEX "local_usage_syncs_workspace" ON "local_usage_syncs" ("workspace");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_agents_worker_agent" ON "worker_agents" ("worker","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_chat_calls_chat_call_stage" ON "worker_chat_calls" ("chat","tool_call_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_chat_calls_task" ON "worker_chat_calls" ("task");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_enrollments_token_hash" ON "worker_enrollments" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_enrollments_completion_worker" ON "worker_enrollments" ("completion_worker");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_gateway_worker" ON "worker_gateway" ("worker");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_gateway_api_key" ON "worker_gateway" ("api_key");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_tasks_worker_request" ON "worker_tasks" ("worker","request_id");--> statement-breakpoint
CREATE INDEX "worker_tasks_queue" ON "worker_tasks" ("worker","status","operation");--> statement-breakpoint
CREATE INDEX "worker_tasks_terminal_at" ON "worker_tasks" ("terminal_at") WHERE "terminal_at" is not null;--> statement-breakpoint
CREATE INDEX "worker_tasks_chat" ON "worker_tasks" ("chat") WHERE "chat" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "project_folders_project_worker" ON "project_folders" ("project","worker");--> statement-breakpoint
CREATE UNIQUE INDEX "project_folders_project_position" ON "project_folders" ("project","position");--> statement-breakpoint
CREATE UNIQUE INDEX "project_folders_one_default" ON "project_folders" ("project") WHERE "is_default";--> statement-breakpoint
CREATE INDEX "project_folders_worker_directory" ON "project_folders" ("worker","directory");--> statement-breakpoint
CREATE INDEX "projects_workspace" ON "projects" ("workspace");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_user" ON "user_preferences" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_servers_workspace_server" ON "workspace_mcp_servers" ("workspace","mcp_server");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_settings_workspace" ON "workspace_settings" ("workspace");--> statement-breakpoint
ALTER TABLE "acp_agent_sessions" ADD CONSTRAINT "acp_agent_sessions_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "acp_agent_sessions" ADD CONSTRAINT "acp_agent_sessions_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_agents" ADD CONSTRAINT "acp_agents_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_commands" ADD CONSTRAINT "acp_commands_issued_by_user_id_fkey" FOREIGN KEY ("issued_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "acp_commands" ADD CONSTRAINT "acp_commands_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_commands" ADD CONSTRAINT "acp_commands_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_interactions" ADD CONSTRAINT "acp_interactions_answered_by_user_id_fkey" FOREIGN KEY ("answered_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "acp_interactions" ADD CONSTRAINT "acp_interactions_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_interactions" ADD CONSTRAINT "acp_interactions_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD CONSTRAINT "acp_sessions_turn_by_user_id_fkey" FOREIGN KEY ("turn_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD CONSTRAINT "acp_sessions_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_sessions" ADD CONSTRAINT "acp_sessions_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_mcp_servers" ADD CONSTRAINT "chat_mcp_servers_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_mcp_servers" ADD CONSTRAINT "chat_mcp_servers_mcp_server_fk" FOREIGN KEY ("workspace","mcp_server") REFERENCES "mcp_servers"("workspace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_runs" ADD CONSTRAINT "chat_runs_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_project_projects_id_fkey" FOREIGN KEY ("project") REFERENCES "projects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_capsules" ADD CONSTRAINT "e2ee_capsules_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_chat_key_wraps" ADD CONSTRAINT "e2ee_chat_key_wraps_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_chat_key_wraps" ADD CONSTRAINT "e2ee_chat_key_wraps_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_chat_key_wraps" ADD CONSTRAINT "e2ee_chat_key_wraps_chat_epoch_fk" FOREIGN KEY ("chat","chat_epoch") REFERENCES "e2ee_chat_keys"("chat","epoch") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_chat_key_wraps" ADD CONSTRAINT "e2ee_chat_key_wraps_workspace_epoch_fk" FOREIGN KEY ("workspace","workspace_epoch") REFERENCES "e2ee_workspace_epochs"("workspace","epoch") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_chat_keys" ADD CONSTRAINT "e2ee_chat_keys_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_chat_keys" ADD CONSTRAINT "e2ee_chat_keys_signer_user_id_user_id_fkey" FOREIGN KEY ("signer_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_invites" ADD CONSTRAINT "e2ee_invites_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_invites" ADD CONSTRAINT "e2ee_invites_invited_user_id_user_id_fkey" FOREIGN KEY ("invited_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_invites" ADD CONSTRAINT "e2ee_invites_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_invites" ADD CONSTRAINT "e2ee_invites_epoch_fk" FOREIGN KEY ("workspace","epoch") REFERENCES "e2ee_workspace_epochs"("workspace","epoch") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_join_requests" ADD CONSTRAINT "e2ee_join_requests_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_join_requests" ADD CONSTRAINT "e2ee_join_requests_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_join_requests" ADD CONSTRAINT "e2ee_join_requests_epoch_fk" FOREIGN KEY ("workspace","epoch") REFERENCES "e2ee_workspace_epochs"("workspace","epoch") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_phrases" ADD CONSTRAINT "e2ee_phrases_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_phrases" ADD CONSTRAINT "e2ee_phrases_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_phrases" ADD CONSTRAINT "e2ee_phrases_epoch_fk" FOREIGN KEY ("workspace","epoch") REFERENCES "e2ee_workspace_epochs"("workspace","epoch") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_rosters" ADD CONSTRAINT "e2ee_rosters_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_trust_stores" ADD CONSTRAINT "e2ee_trust_stores_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_worker_keys" ADD CONSTRAINT "e2ee_worker_keys_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_worker_pairings" ADD CONSTRAINT "e2ee_worker_pairings_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_worker_pairings" ADD CONSTRAINT "e2ee_worker_pairings_owner_user_id_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_worker_pairings" ADD CONSTRAINT "e2ee_worker_pairings_enrollment_worker_enrollments_id_fkey" FOREIGN KEY ("enrollment") REFERENCES "worker_enrollments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_worker_pairings" ADD CONSTRAINT "e2ee_worker_pairings_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_workspace_epochs" ADD CONSTRAINT "e2ee_workspace_epochs_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_workspace_epochs" ADD CONSTRAINT "e2ee_workspace_epochs_created_by_user_id_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_workspace_grants" ADD CONSTRAINT "e2ee_workspace_grants_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "e2ee_workspace_grants" ADD CONSTRAINT "e2ee_workspace_grants_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_workspace_grants" ADD CONSTRAINT "e2ee_workspace_grants_granter_user_id_user_id_fkey" FOREIGN KEY ("granter_user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "e2ee_workspace_grants" ADD CONSTRAINT "e2ee_workspace_grants_epoch_fk" FOREIGN KEY ("workspace","epoch") REFERENCES "e2ee_workspace_epochs"("workspace","epoch") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "credential_limits" ADD CONSTRAINT "credential_limits_credential_workspace_credentials_id_fkey" FOREIGN KEY ("credential") REFERENCES "workspace_credentials"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "limit_events" ADD CONSTRAINT "limit_events_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "limit_events" ADD CONSTRAINT "limit_events_credential_workspace_credentials_id_fkey" FOREIGN KEY ("credential") REFERENCES "workspace_credentials"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_author_authors_id_fkey" FOREIGN KEY ("author") REFERENCES "authors"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "secret_events" ADD CONSTRAINT "secret_events_secret_secrets_id_fkey" FOREIGN KEY ("secret") REFERENCES "secrets"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_credentials" ADD CONSTRAINT "workspace_credentials_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_providers" ADD CONSTRAINT "workspace_providers_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_limit_event_limit_events_id_fkey" FOREIGN KEY ("limit_event") REFERENCES "limit_events"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_blobs" ADD CONSTRAINT "telemetry_blobs_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_destinations" ADD CONSTRAINT "telemetry_destinations_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_nodes" ADD CONSTRAINT "telemetry_nodes_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_nodes" ADD CONSTRAINT "telemetry_nodes_parent_telemetry_nodes_id_fkey" FOREIGN KEY ("parent") REFERENCES "telemetry_nodes"("id");--> statement-breakpoint
ALTER TABLE "telemetry_nodes" ADD CONSTRAINT "telemetry_nodes_blob_telemetry_blobs_id_fkey" FOREIGN KEY ("blob") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_api_key_api_keys_id_fkey" FOREIGN KEY ("api_key") REFERENCES "api_keys"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_session_telemetry_sessions_id_fkey" FOREIGN KEY ("session") REFERENCES "telemetry_sessions"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_credential_workspace_credentials_id_fkey" FOREIGN KEY ("credential") REFERENCES "workspace_credentials"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_chat_completion_chat_completions_id_fkey" FOREIGN KEY ("chat_completion") REFERENCES "chat_completions"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_input_telemetry_nodes_id_fkey" FOREIGN KEY ("input") REFERENCES "telemetry_nodes"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_output_telemetry_nodes_id_fkey" FOREIGN KEY ("output") REFERENCES "telemetry_nodes"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_system_telemetry_blobs_id_fkey" FOREIGN KEY ("system") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_toolset_telemetry_blobs_id_fkey" FOREIGN KEY ("toolset") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_params_telemetry_blobs_id_fkey" FOREIGN KEY ("params") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_headers_telemetry_blobs_id_fkey" FOREIGN KEY ("headers") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_legacy_input_telemetry_blobs_id_fkey" FOREIGN KEY ("legacy_input") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_legacy_output_telemetry_blobs_id_fkey" FOREIGN KEY ("legacy_output") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_requests" ADD CONSTRAINT "telemetry_requests_legacy_spans_telemetry_blobs_id_fkey" FOREIGN KEY ("legacy_spans") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "telemetry_sessions" ADD CONSTRAINT "telemetry_sessions_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_sessions" ADD CONSTRAINT "telemetry_sessions_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "telemetry_toolset_tools" ADD CONSTRAINT "telemetry_toolset_tools_toolset_telemetry_blobs_id_fkey" FOREIGN KEY ("toolset") REFERENCES "telemetry_blobs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "telemetry_toolset_tools" ADD CONSTRAINT "telemetry_toolset_tools_tool_telemetry_blobs_id_fkey" FOREIGN KEY ("tool") REFERENCES "telemetry_blobs"("id");--> statement-breakpoint
ALTER TABLE "acp_model_prices" ADD CONSTRAINT "acp_model_prices_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_usage" ADD CONSTRAINT "acp_usage_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_usage" ADD CONSTRAINT "acp_usage_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "acp_usage" ADD CONSTRAINT "acp_usage_price_key_acp_model_prices_id_fkey" FOREIGN KEY ("price_key") REFERENCES "acp_model_prices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "acp_usage" ADD CONSTRAINT "acp_usage_chat_fk" FOREIGN KEY ("chat","workspace") REFERENCES "chats"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "acp_usage" ADD CONSTRAINT "acp_usage_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_completions" ADD CONSTRAINT "chat_completions_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "chat_completions" ADD CONSTRAINT "chat_completions_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat_completions" ADD CONSTRAINT "chat_completions_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_completions" ADD CONSTRAINT "chat_completions_api_key_api_keys_id_fkey" FOREIGN KEY ("api_key") REFERENCES "api_keys"("id");--> statement-breakpoint
ALTER TABLE "chat_completions" ADD CONSTRAINT "chat_completions_credential_workspace_credentials_id_fkey" FOREIGN KEY ("credential") REFERENCES "workspace_credentials"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "chat_completions" ADD CONSTRAINT "chat_completions_app_ai_apps_id_fkey" FOREIGN KEY ("app") REFERENCES "ai_apps"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_completions" ADD CONSTRAINT "chat_completions_model_models_id_fkey" FOREIGN KEY ("model") REFERENCES "models"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "local_usage" ADD CONSTRAINT "local_usage_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "local_usage" ADD CONSTRAINT "local_usage_price_key_acp_model_prices_id_fkey" FOREIGN KEY ("price_key") REFERENCES "acp_model_prices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "local_usage" ADD CONSTRAINT "local_usage_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "local_usage_syncs" ADD CONSTRAINT "local_usage_syncs_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "local_usage_syncs" ADD CONSTRAINT "local_usage_syncs_worker_fk" FOREIGN KEY ("worker","workspace") REFERENCES "workers"("id","workspace") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_agents" ADD CONSTRAINT "worker_agents_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_chat_calls" ADD CONSTRAINT "worker_chat_calls_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_chat_calls" ADD CONSTRAINT "worker_chat_calls_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "worker_chat_calls" ADD CONSTRAINT "worker_chat_calls_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_chat_calls" ADD CONSTRAINT "worker_chat_calls_task_worker_tasks_id_fkey" FOREIGN KEY ("task") REFERENCES "worker_tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "worker_enrollments" ADD CONSTRAINT "worker_enrollments_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_enrollments" ADD CONSTRAINT "worker_enrollments_completion_worker_workers_id_fkey" FOREIGN KEY ("completion_worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_enrollments" ADD CONSTRAINT "worker_enrollments_completion_key_worker_keys_id_fkey" FOREIGN KEY ("completion_key") REFERENCES "worker_keys"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_gateway" ADD CONSTRAINT "worker_gateway_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_gateway" ADD CONSTRAINT "worker_gateway_api_key_api_keys_id_fkey" FOREIGN KEY ("api_key") REFERENCES "api_keys"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "worker_tasks" ADD CONSTRAINT "worker_tasks_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_tasks" ADD CONSTRAINT "worker_tasks_chat_chats_id_fkey" FOREIGN KEY ("chat") REFERENCES "chats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "worker_tasks" ADD CONSTRAINT "worker_tasks_edit_owner_id_user_id_fkey" FOREIGN KEY ("edit_owner_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_project_projects_id_fkey" FOREIGN KEY ("project") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_worker_workers_id_fkey" FOREIGN KEY ("worker") REFERENCES "workers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_mcp_server_fk" FOREIGN KEY ("workspace","mcp_server") REFERENCES "mcp_servers"("workspace","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_workspaces_id_fkey" FOREIGN KEY ("workspace") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_key_epoch" CHECK ("key_epoch" is null or "key_epoch" >= 1);