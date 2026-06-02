// Loop CRM — Customer Segments (Smart Lists + Manual Groups)
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { authMiddleware, workspaceMiddleware } from "../lib/middleware";
import { generateId, nowIso } from "../lib/auth";

const segments = new Hono<{ Bindings: Bindings; Variables: Variables }>();
segments.use("*", authMiddleware, workspaceMiddleware);

// List segments
segments.get("/", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;

  const { data } = await db.from("crm_customer_segments")
    .select("*").eq("workspace_id", workspaceId).is("deleted_at", null)
    .order("created_at", { ascending: false });

  return c.json({ segments: data || [] });
});

// Create segment
segments.post("/", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => null) as {
    name?: string; description?: string; is_smart?: boolean; filter_criteria?: Record<string, unknown>;
  } | null;

  if (!body?.name) return c.json({ error: "name is required" }, 400);

  const now = nowIso();
  const segmentId = generateId();
  const { data: segment, error } = await db.from("crm_customer_segments").insert({
    id: segmentId,
    workspace_id: workspaceId,
    name: body.name,
    description: body.description || null,
    is_smart: body.is_smart !== false,
    filter_criteria: body.filter_criteria || {},
    member_count: 0,
    created_by: user.id,
    created_at: now,
    updated_at: now,
  }).select().single();
  if (error) return c.json({ error: "Failed to create segment" }, 500);

  await db.from("crm_audit_log").insert({
    id: generateId(), workspace_id: workspaceId, actor_user_id: user.id,
    action: "segment.created", resource_type: "segment", resource_id: segmentId,
    payload: { name: body.name, is_smart: body.is_smart !== false }, created_at: now,
  });

  return c.json({ segment }, 201);
});

// Get segment members (resolves smart filters in real-time)
segments.get("/:id/members", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const id = c.req.param("id");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
  const offset = parseInt(c.req.query("offset") || "0");

  const { data: segment } = await db.from("crm_customer_segments")
    .select("*").eq("id", id).eq("workspace_id", workspaceId).is("deleted_at", null).single();
  if (!segment) return c.json({ error: "Segment not found" }, 404);

  let members: unknown[] = [];
  let total = 0;

  if (segment.is_smart) {
    // Resolve smart filter criteria
    const criteria = segment.filter_criteria as Record<string, unknown>;
    let query = db.from("crm_customers")
      .select("*", { count: "exact" })
      .eq("workspace_id", workspaceId).is("deleted_at", null).eq("is_primary", true)
      .range(offset, offset + limit - 1);

    if (criteria.status) query = query.eq("status", criteria.status);
    if (criteria.source) query = query.eq("source", criteria.source);
    if (Array.isArray(criteria.tags) && criteria.tags.length) query = query.contains("tags", criteria.tags);
    if (typeof criteria.min_spend === "number") query = query.gte("total_spend", criteria.min_spend);
    if (typeof criteria.max_spend === "number") query = query.lte("total_spend", criteria.max_spend);

    const { data, count } = await query;
    members = data || [];
    total = count || 0;
  } else {
    // Manual segment members
    const { data, count } = await db.from("crm_customer_segment_members")
      .select("crm_customers(*)", { count: "exact" })
      .eq("segment_id", id).range(offset, offset + limit - 1);
    members = (data || []).map((m: Record<string, unknown>) => m.crm_customers);
    total = count || 0;
  }

  // Update cached count for smart segments
  if (segment.is_smart) {
    await db.from("crm_customer_segments").update({ member_count: total, updated_at: nowIso() }).eq("id", id);
  }

  return c.json({ members, total, limit, offset });
});

// Add member to manual segment
segments.post("/:id/members", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const user = c.get("user")!;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { customer_id?: string } | null;
  if (!body?.customer_id) return c.json({ error: "customer_id required" }, 400);

  const { data: segment } = await db.from("crm_customer_segments")
    .select("is_smart").eq("id", id).eq("workspace_id", workspaceId).single();
  if (!segment) return c.json({ error: "Segment not found" }, 404);
  if (segment.is_smart) return c.json({ error: "Cannot manually add members to a smart segment" }, 400);

  const now = nowIso();
  const { error } = await db.from("crm_customer_segment_members").insert({
    id: generateId(), segment_id: id, customer_id: body.customer_id, added_by: user.id, added_at: now,
  });
  if (error?.code === "23505") return c.json({ error: "Customer already in segment" }, 409);
  if (error) return c.json({ error: "Failed to add to segment" }, 500);

  // Update cached count
  await db.from("crm_customer_segments").update({
    member_count: db.rpc("increment", { x: 1 }), updated_at: now,
  }).eq("id", id);

  return c.json({ added: true });
});

// Delete segment
segments.delete("/:id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const user = c.get("user")!;
  const id = c.req.param("id");

  if (!["owner", "admin"].includes(c.get("workspace_role") || "")) {
    return c.json({ error: "Only owners and admins can delete segments" }, 403);
  }

  const now = nowIso();
  await db.from("crm_customer_segments").update({ deleted_at: now }).eq("id", id).eq("workspace_id", workspaceId);
  await db.from("crm_audit_log").insert({
    id: generateId(), workspace_id: workspaceId, actor_user_id: user.id,
    action: "segment.deleted", resource_type: "segment", resource_id: id, payload: {}, created_at: now,
  });

  return c.json({ deleted: true });
});

export default segments;
