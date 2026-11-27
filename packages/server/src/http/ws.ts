import { defineWebSocketHandler } from "nitro";

import { getPorts } from "../ports";
import { createContext } from "../trpc/context";
import { logTRPCError } from "../trpc/init";
import { appRouter } from "../trpc/router";
import { createTRPCWebSocketHooks } from "../trpc/ws-bridge";

/** `/api/ws`: the one WebSocket per browser Tab or Worker, serving the whole tRPC router. */
const { hooks } = createTRPCWebSocketHooks({
  router: appRouter,
  createContext: async ({ request, connectionParams }) => {
    return createContext(await getPorts(), { headers: request.headers, connectionParams });
  },
  onError: logTRPCError,
});

export default defineWebSocketHandler(hooks);
