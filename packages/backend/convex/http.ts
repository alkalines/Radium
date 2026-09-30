import { HttpRouterWithHono } from "convex-helpers/server/hono";
import { app } from "../src/http/router";
import { authComponent, createAuth } from "./auth";

const http = new HttpRouterWithHono(app);

// Better Auth owns its routes and CORS independently of the application router.
authComponent.registerRoutes(http, createAuth);

export default http;
