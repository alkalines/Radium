import type { Telemetry } from "ai";
import { internal } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { ActionCtx } from "../../../convex/_generated/server";
import {
  createTelemetryIntegrations as createTelemetryCollectorIntegrations,
  type TelemetrySettings,
  type TelemetrySource,
} from "./integration";

export type { TelemetrySettings } from "./integration";

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

/** Attach server-derived ownership and Convex persistence to the reusable collector. */
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
