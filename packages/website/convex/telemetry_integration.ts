import type { Telemetry } from "ai";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import {
  createTelemetryIntegrations as createTelemetryCollectorIntegrations,
  type TelemetrySettings,
  type TelemetrySource,
} from "../src/utils/telemetry/integration";

export type { TelemetrySettings } from "../src/utils/telemetry/integration";

export type TelemetryRequestContext = {
  balance: Id<"balances">;
  key?: Id<"keys">;
  chatId?: Id<"aisdk_chats">;
  userId: string;
  requestId: string;
  settings: TelemetrySettings;
};

type CollectorOptions = TelemetryRequestContext & {
  ctx: ActionCtx;
  source: TelemetrySource;
  functionId: string;
};

/** Build the local collector and, when configured, an OTLP integration for one request. */
export function createTelemetryIntegrations(options: CollectorOptions): Telemetry[] {
  return createTelemetryCollectorIntegrations({
    requestId: options.requestId,
    source: options.source,
    functionId: options.functionId,
    settings: options.settings,
    persistence: {
      startTrace: (trace) =>
        options.ctx.runMutation(internal.telemetry.startTrace, {
          balance: options.balance,
          key: options.key,
          userId: options.userId,
          chatId: options.chatId,
          ...trace,
        }),
      finishTrace: (trace) => options.ctx.runMutation(internal.telemetry.finishTrace, trace),
    },
  });
}
