// Loop CRM — Workspace Management Routes
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { authMiddleware } from "../lib/middleware";
import { generateId, nowIso } from "../lib/auth";

const workspaces = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Create workspace
workspaces.post("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => null) as { name?: string; slug?: string } | null;
  if (!body?.name) return c.json({ error: "name is required" }, 400);

  const slug = body.slug || body.name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
  const db = c.get("db");

  // Check slug uniqueness
  const { data: existing } = await db.from("crm_workspaces").select("id").eq("slug", slug).single();
  if (existing) return c.json({ error: "Workspace slug already taken" }, 409);

  const workspaceId = generateId();
  const now = nowIso();

  const { data: workspace, error } = await db.from("crm_workspaces").insert({
    id: workspaceId,
    name: body.name,
    slug,
    owner_user_id: user.id,
    plan: "starter",
    created_at: now,
    updated_at: now,
  }).select().single();

  if (error) return c.json({ error: "Failed to create workspace" }, 500);

  // Add owner as member
  await db.from("crm_workspace_members").insert({
    id: generateId(),
    workspace_id: workspaceId,
    user_id: user.id,
    role: "owner",
    joined_at: now,
    created_at: now,
  });

  // Audit trail
  await db.from("crm_audit_log").insert({
    id: generateId(),
    workspace_id: workspaceId,
    actor_user_id: user.id,
    action: "workspace.created",
    resource_type: "workspace",
    resource_id: workspaceId,
    payload: { name: body.name, slug },
    created_at: now,
  });

  return c.json({ workspace }, 201);
});

// Get current workspace
workspaces.get("/:id", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = c.req.param("id");
  const db = c.get("db");

  const { data: member } = await db
    .from("crm_workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return c.json({ error: "Not a member of this workspace" }, 403);

  const { data: workspace } = await db
    .from("crm_workspaces")
    .select("*")
    .eq("id", workspaceId)
    .is("deleted_at", null)
    .single();
  if (!workspace) return c.json({ error: "Workspace not found" }, 404);

  return c.json({ workspace, role: member.role });
});

// List user's workspaces
workspaces.get("/", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const db = c.get("db");

  const { data: memberships } = await db
    .from("crm_workspace_members")
    .select("role, crm_workspaces(*)")
    .eq("user_id", user.id);

  const list = (memberships || []).map((m: Record<string, unknown>) => ({
    ...(m.crm_workspaces as Record<string, unknown>),
    role: m.role,
  }));

  return c.json({ workspaces: list });
});

// Invite member
workspaces.post("/:id/members", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = c.req.param("id");
  const db = c.get("db");
  const body = await c.req.json().catch(() => null) as { user_id?: string; role?: string } | null;
  if (!body?.user_id) return c.json({ error: "user_id required" }, 400);

  const { data: myMembership } = await db
    .from("crm_workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!myMembership || !["owner", "admin"].includes(myMembership.role)) {
    return c.json({ error: "Only owners and admins can invite members" }, 403);
  }

  const role = body.role || "member";
  if (!["admin", "member", "viewer"].includes(role)) return c.json({ error: "Invalid role" }, 400);

  const now = nowIso();
  const { data: member, error } = await db.from("crm_workspace_members").insert({
    id: generateId(),
    workspace_id: workspaceId,
    user_id: body.user_id,
    role,
    invited_by: user.id,
    joined_at: now,
    created_at: now,
  }).select().single();
  if (error?.code === "23505") return c.json({ error: "User is already a member" }, 409);
  if (error) return c.json({ error: "Failed to add member" }, 500);

  await db.from("crm_audit_log").insert({
    id: generateId(),
    workspace_id: workspaceId,
    actor_user_id: user.id,
    action: "workspace.member_added",
    resource_type: "workspace_member",
    resource_id: body.user_id,
    payload: { role },
    created_at: now,
  });

  return c.json({ member }, 201);
});

// List workspace members
workspaces.get("/:id/members", authMiddleware, async (c) => {
  const user = c.get("user")!;
  const workspaceId = c.req.param("id");
  const db = c.get("db");

  const { data: myMembership } = await db
    .from("crm_workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!myMembership) return c.json({ error: "Not a member" }, 403);

  const { data: members } = await db
    .from("crm_workspace_members").select("*")
    .eq("workspace_id", workspaceId).order("created_at", { ascending: true });

  return c.json({ members: members || [] });
});

export default workspaces;
