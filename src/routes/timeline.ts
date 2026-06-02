// Loop CRM — Customer Activity Timeline
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { authMiddleware, workspaceMiddleware } from "../lib/middleware";
import { generateId, nowIso } from "../lib/auth";

const timeline = new Hono<{ Bindings: Bindings; Variables: Variables }>();
timeline.use("*", authMiddleware, workspaceMiddleware);

const VALID_EVENT_TYPES = [
  "customer.created", "customer.updated", "customer.deleted",
  "note.added", "note.updated", "note.deleted",
  "tag.added", "tag.removed",
  "channel.linked", "channel.verified", "channel.removed",
  "segment.added", "segment.removed",
  "merge.completed", "merge.rolled_back",
  "booking.made", "booking.cancelled",
  "purchase.made", "purchase.refunded",
  "message.sent", "message.received",
  "custom",
];

// Get timeline for a customer
timeline.get("/customer/:customer_id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const customerId = c.req.param("customer_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
  const offset = parseInt(c.req.query("offset") || "0");
  const eventType = c.req.query("event_type");

  // Verify customer in workspace
  const { data: cust } = await db.from("crm_customers")
    .select("id").eq("id", customerId).eq("workspace_id", workspaceId).single();
  if (!cust) return c.json({ error: "Customer not found" }, 404);

  let query = db.from("crm_customer_activity")
    .select("*", { count: "exact" })
    .eq("customer_id", customerId).eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (eventType) query = query.eq("event_type", eventType);

  const { data, count } = await query;
  return c.json({ events: data || [], total: count || 0, limit, offset });
});

// Append a custom event to timeline (for external systems)
timeline.post("/customer/:customer_id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const user = c.get("user")!;
  const customerId = c.req.param("customer_id");
  const body = await c.req.json().catch(() => null) as {
    event_type?: string; event_data?: Record<string, unknown>; channel?: string;
  } | null;

  if (!body?.event_type) return c.json({ error: "event_type is required" }, 400);
  const eventType = VALID_EVENT_TYPES.includes(body.event_type) ? body.event_type : "custom";

  const { data: cust } = await db.from("crm_customers")
    .select("id").eq("id", customerId).eq("workspace_id", workspaceId).is("deleted_at", null).single();
  if (!cust) return c.json({ error: "Customer not found" }, 404);

  const now = nowIso();
  const { data: event, error } = await db.from("crm_customer_activity").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: customerId,
    actor_user_id: user.id, event_type: eventType,
    event_data: body.event_data || {}, channel: body.channel || null, created_at: now,
  }).select().single();
  if (error) return c.json({ error: "Failed to log event" }, 500);

  // Update last_seen_at for engagement events
  const engagementEvents = ["message.sent", "message.received", "booking.made", "purchase.made"];
  if (engagementEvents.includes(eventType)) {
    await db.from("crm_customers").update({ last_seen_at: now, updated_at: now }).eq("id", customerId);
  }

  return c.json({ event }, 201);
});

// Workspace-level activity feed (recent events across all customers)
timeline.get("/workspace", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  const { data: events } = await db.from("crm_customer_activity")
    .select("*, crm_customers(id, name, email, avatar_url)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return c.json({ events: events || [] });
});

export default timeline;
