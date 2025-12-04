import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

const signInRoutes = ["/auth/sign-in", "/auth/sign-up", "/auth/verify-2fa", "/auth/reset-password"];

// Just check cookie, recommended approach
export async function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  const isSignInRoute = signInRoutes.includes(request.nextUrl.pathname);

  if (isSignInRoute && !sessionCookie) {
    return NextResponse.next();
  }

  if (!isSignInRoute && !sessionCookie) {
    return NextResponse.redirect(new URL("/auth/sign-in", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Run middleware on all routes except static assets and api routes
  matcher: ["/((?!.*\\..*|_next|api/auth).*)", "/trpc(.*)"],
};
