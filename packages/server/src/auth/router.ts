import { router, sessionProcedure } from "../trpc/init";

export const authRouter = router({
  /** The signed-in user's profile, for account menus. */
  me: sessionProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    name: ctx.user.name,
    image: ctx.user.image ?? null,
  })),
});
