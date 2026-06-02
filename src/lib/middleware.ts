// Loop CRM — Hono Middleware
// LILCKY STUDIO LIMITED

import type { Context, Next } from "hono";
import { verifyJwt } from "./auth";
import type { Bindings, Variables } from "../index";

export async function authMiddleware(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
): Promise<Response | void> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }
  const token = authHeader.slice(7);
  const payload = await verifyJwt(token, c.env.RALD_JWT_SECRET);
  if (!payload) return c.json({ error: "Invalid or expired token" }, 401);
  c.set("user", payload);
  await next();
}

export async function workspaceMiddleware(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
): Promise<Response | void> {
  const user = c.get("user")!;
  const workspaceId = c.req.header("X-Workspace-ID") || c.req.query("workspace_id");
  if (!workspaceId) return c.json({ error: "X-Workspace-ID header or workspace_id query param required" }, 400);

  // Verify the user is a member of this workspace
  const db = c.get("db");
  const { data: member } = await db
    .from("crm_workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member) return c.json({ error: "Not a member of this workspace" }, 403);

  c.set("workspace_id", workspaceId);
  c.set("workspace_role", member.role);
  await next();
}

export async function requireRole(
  roles: string[],
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
): Promise<Response | void> {
  const role = c.get("workspace_role");
  if (!roles.includes(role)) return c.json({ error: "Insufficient workspace permissions" }, 403);
  await next();
}
