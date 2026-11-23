import { base64urlBytes } from "contracts/wire";
import { CAPSULE_BYTES } from "radium-crypto";
import { z } from "zod";
import { router, sessionProcedure, workspaceProcedure } from "../trpc/init";
import { createUpload, historicalFile, registerFile } from "./files";

const registerInput = z.object({
  id: z.uuid(),
  mediaType: z.string().max(129).optional(),
  e2ee: z.object({
    fileId: z.string().max(32),
    capsule: base64urlBytes(CAPSULE_BYTES),
    chatEpoch: z.number().int(),
    e2eeParent: z.string().max(32),
  }),
});

export const chatFilesRouter = router({
  /** An upload slot: `PUT` the encrypted bytes to `uploadUrl`, then `register`. */
  createUpload: workspaceProcedure.mutation(({ ctx }) =>
    createUpload(ctx.runtime, ctx.access, ctx.user.id),
  ),
  /** The pending attachment's file part; `null` when the upload cannot be registered. */
  register: workspaceProcedure
    .input(registerInput)
    .mutation(({ ctx, input }) =>
      registerFile(ctx.runtime, ctx.access, ctx.user.id, {
        id: input.id,
        mediaType: input.mediaType,
        e2ee: input.e2ee,
      }),
    ),
  /** The sealed sidecar of an imported attachment of an accessible chat. */
  historicalFile: sessionProcedure
    .input(z.object({ chatId: z.string().min(1).max(256), url: z.string().max(2048) }))
    .query(({ ctx, input }) => historicalFile(ctx.runtime.drivers.db, ctx.user.id, input)),
});
