// Loop CRM — Cloudflare Worker
// Deployed at: crm.rald.cloud | Version: 1.0.0
// LILCKY STUDIO LIMITED

import { type SupabaseClient, createClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { JwtPayload } from "./lib/auth";
import channelRoutes from "./routes/channels";
import customerRoutes from "./routes/customers";
import mergeRoutes from "./routes/merge";
import segmentRoutes from "./routes/segments";
import timelineRoutes from "./routes/timeline";
import workspaceRoutes from "./routes/workspaces";

export type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RALD_JWT_SECRET: string;
  ENVIRONMENT: string;
};

export type Variables = {
  db: SupabaseClient;
  user?: JwtPayload;
  workspace_id?: string;
  workspace_role?: string;
};

const VERSION = "1.0.0";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use("*", cors({
  origin: [
    "https://rald.cloud", "https://app.rald.cloud", "https://loop.rald.cloud",
    "https://business.rald.cloud", "https://admin.rald.cloud", "https://control.rald.cloud",
    "https://sv.rald.cloud", "https://crm.rald.cloud", "https://messenger.rald.cloud",
    "https://rald-loop-business.pages.dev", "https://rald-control-center.pages.dev",
    "http://localhost:5173", "http://localhost:3000", "http://localhost:3001",
  ],
  allowHeaders: ["Authorization", "Content-Type", "X-Request-ID", "X-Workspace-ID"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  credentials: true,
}));

// ── Supabase client per request ───────────────────────────────────────────────
app.use("*", async (c, next) => {
  c.set("db", createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY));
  await next();
});

// ── Health & info ─────────────────────────────────────────────────────────────
app.get("/health", (c) => c.json({ status: "ok", service: "loop-crm", version: VERSION }));

app.get("/", (c) =>
  c.json({
    service: "Loop CRM — Customer Graph",
    version: VERSION,
    operator: "LILCKY STUDIO LIMITED",
    endpoints: {
      health: "GET /health",
      workspaces: "/workspaces/*",
      customers: "/customers/*",
      channels: "/channels/*",
      segments: "/segments/*",
      timeline: "/timeline/*",
      merge: "/merge/*",
    },
  })
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.route("/workspaces", workspaceRoutes);
app.route("/customers",  customerRoutes);
app.route("/channels",   channelRoutes);
app.route("/segments",   segmentRoutes);
app.route("/timeline",   timelineRoutes);
app.route("/merge",      mergeRoutes);

// ── Not found & error ─────────────────────────────────────────────────────────
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error("Unhandled error:", err.message);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
