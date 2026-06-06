// Loop CRM — Customer CRUD Routes
// Single canonical customer model per workspace — workspace-isolated, RBAC-enforced
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { authMiddleware, workspaceMiddleware } from "../lib/middleware";
import { generateId, nowIso } from "../lib/auth";
import type { JwtPayload } from "../lib/auth";

const customers = new Hono<{ Bindings: Bindings; Variables: Variables }>();
customers.use("*", authMiddleware, workspaceMiddleware);

// ── List / Search ─────────────────────────────────────────────────────────────
customers.get("/", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;

  const q       = c.req.query("q") || "";
  const status  = c.req.query("status");
  const source  = c.req.query("source");
  const tag     = c.req.query("tag");
  const limit   = Math.min(Number.parseInt(c.req.query("limit") || "50"), 200);
  const offset  = Number.parseInt(c.req.query("offset") || "0");

  let query = db.from("crm_customers")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .is("deleted_at", null)
    .eq("is_primary", true)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%,company.ilike.%${q}%`);
  if (status) query = query.eq("status", status);
  if (source) query = query.eq("source", source);
  if (tag) query = query.contains("tags", [tag]);

  const { data, count, error } = await query;
  if (error) return c.json({ error: "Failed to fetch customers" }, 500);

  return c.json({ customers: data || [], total: count || 0, limit, offset });
});

// ── Get single ────────────────────────────────────────────────────────────────
customers.get("/:id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const id = c.req.param("id");

  const { data: customer } = await db.from("crm_customers")
    .select("*").eq("id", id).eq("workspace_id", workspaceId).is("deleted_at", null).single();
  if (!customer) return c.json({ error: "Customer not found" }, 404);

  const { data: channels } = await db.from("crm_customer_channels")
    .select("*").eq("customer_id", id).eq("workspace_id", workspaceId);

  return c.json({ customer, channels: channels || [] });
});

// ── Create ────────────────────────────────────────────────────────────────────
customers.post("/", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const user = c.get("user") as JwtPayload;
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body?.name) return c.json({ error: "name is required" }, 400);

  // Role check — viewers cannot create
  if (c.get("workspace_role") === "viewer") return c.json({ error: "Viewers cannot create customers" }, 403);

  // Deduplication: check for existing customer by email or phone
  const email = typeof body.email === "string" ? body.email.toLowerCase().trim() : null;
  const phone = typeof body.phone === "string" ? body.phone.trim() : null;

  if (email) {
    const { data: dupe } = await db.from("crm_customers")
      .select("id").eq("workspace_id", workspaceId).eq("email", email).is("deleted_at", null).single();
    if (dupe) return c.json({ error: "A customer with this email already exists", existing_id: dupe.id }, 409);
  }

  const now = nowIso();
  const customerId = generateId();

  const { data: customer, error } = await db.from("crm_customers").insert({
    id: customerId,
    workspace_id: workspaceId,
    rald_user_id: body.rald_user_id || null,
    name: body.name,
    email,
    phone,
    avatar_url: body.avatar_url || null,
    source: body.source || "manual",
    status: "active",
    tags: Array.isArray(body.tags) ? body.tags : [],
    company: body.company || null,
    job_title: body.job_title || null,
    location: body.location || null,
    timezone: body.timezone || "Africa/Lagos",
    language: body.language || "en",
    currency: body.currency || "NGN",
    total_spend: 0,
    conversation_count: 0,
    booking_count: 0,
    first_seen_at: now,
    is_primary: true,
    created_by: user.id,
    updated_by: user.id,
    created_at: now,
    updated_at: now,
  }).select().single();
  if (error) return c.json({ error: "Failed to create customer" }, 500);

  // Auto-link channels
  const channelInserts = [];
  if (email) channelInserts.push({ id: generateId(), workspace_id: workspaceId, customer_id: customerId, channel_type: "email", channel_id: email, is_primary: true, created_at: now });
  if (phone) channelInserts.push({ id: generateId(), workspace_id: workspaceId, customer_id: customerId, channel_type: "phone", channel_id: phone, is_primary: !email, created_at: now });
  if (channelInserts.length) await db.from("crm_customer_channels").insert(channelInserts);

  // Activity log
  await db.from("crm_customer_activity").insert({
    id: generateId(),
    workspace_id: workspaceId,
    customer_id: customerId,
    actor_user_id: user.id,
    event_type: "customer.created",
    event_data: { source: body.source || "manual" },
    created_at: now,
  });

  // Audit trail
  await db.from("crm_audit_log").insert({
    id: generateId(),
    workspace_id: workspaceId,
    actor_user_id: user.id,
    action: "customer.created",
    resource_type: "customer",
    resource_id: customerId,
    payload: { name: body.name, email, source: body.source },
    created_at: now,
  });

  return c.json({ customer }, 201);
});

// ── Update ────────────────────────────────────────────────────────────────────
customers.patch("/:id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const user = c.get("user") as JwtPayload;
  const id = c.req.param("id");

  if (c.get("workspace_role") === "viewer") return c.json({ error: "Viewers cannot update customers" }, 403);

  const { data: existing } = await db.from("crm_customers")
    .select("id").eq("id", id).eq("workspace_id", workspaceId).is("deleted_at", null).single();
  if (!existing) return c.json({ error: "Customer not found" }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const allowed = ["name","email","phone","avatar_url","status","tags","company","job_title","location","timezone","language","currency","rald_user_id"];
  const updates: Record<string, unknown> = { updated_at: nowIso(), updated_by: user.id };
  for (const key of allowed) if (key in body) updates[key] = body[key];

  const { data: customer, error } = await db.from("crm_customers").update(updates).eq("id", id).select().single();
  if (error) return c.json({ error: "Failed to update customer" }, 500);

  await db.from("crm_customer_activity").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: id,
    actor_user_id: user.id, event_type: "customer.updated",
    event_data: { fields: Object.keys(updates).filter(k => k !== "updated_at" && k !== "updated_by") },
    created_at: nowIso(),
  });

  await db.from("crm_audit_log").insert({
    id: generateId(), workspace_id: workspaceId, actor_user_id: user.id,
    action: "customer.updated", resource_type: "customer", resource_id: id,
    payload: updates, created_at: nowIso(),
  });

  return c.json({ customer });
});

// ── Add/Remove Tag ────────────────────────────────────────────────────────────
customers.post("/:id/tags", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const user = c.get("user") as JwtPayload;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { tag?: string } | null;
  if (!body?.tag) return c.json({ error: "tag required" }, 400);

  const { data: cust } = await db.from("crm_customers").select("tags").eq("id", id).eq("workspace_id", workspaceId).single();
  if (!cust) return c.json({ error: "Customer not found" }, 404);

  const tags = Array.isArray(cust.tags) ? cust.tags : [];
  if (tags.includes(body.tag)) return c.json({ message: "Tag already applied" });

  const now = nowIso();
  await db.from("crm_customers").update({ tags: [...tags, body.tag], updated_at: now }).eq("id", id);
  await db.from("crm_customer_activity").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: id,
    actor_user_id: user.id, event_type: "tag.added", event_data: { tag: body.tag }, created_at: now,
  });

  return c.json({ tags: [...tags, body.tag] });
});

customers.delete("/:id/tags/:tag", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const user = c.get("user") as JwtPayload;
  const { id, tag } = c.req.param();

  const { data: cust } = await db.from("crm_customers").select("tags").eq("id", id).eq("workspace_id", workspaceId).single();
  if (!cust) return c.json({ error: "Customer not found" }, 404);

  const tags = (Array.isArray(cust.tags) ? cust.tags : []).filter((t: string) => t !== tag);
  const now = nowIso();
  await db.from("crm_customers").update({ tags, updated_at: now }).eq("id", id);
  await db.from("crm_customer_activity").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: id,
    actor_user_id: user.id, event_type: "tag.removed", event_data: { tag }, created_at: now,
  });

  return c.json({ tags });
});

// ── Notes ─────────────────────────────────────────────────────────────────────
customers.get("/:id/notes", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const id = c.req.param("id");
  const { data: notes } = await db.from("crm_customer_notes")
    .select("*").eq("customer_id", id).eq("workspace_id", workspaceId).is("deleted_at", null)
    .order("is_pinned", { ascending: false }).order("created_at", { ascending: false });
  return c.json({ notes: notes || [] });
});

customers.post("/:id/notes", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const user = c.get("user") as JwtPayload;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => null) as { content?: string; is_pinned?: boolean } | null;
  if (!body?.content) return c.json({ error: "content required" }, 400);

  const now = nowIso();
  const noteId = generateId();
  const { data: note, error } = await db.from("crm_customer_notes").insert({
    id: noteId, workspace_id: workspaceId, customer_id: id,
    author_user_id: user.id, content: body.content,
    is_pinned: body.is_pinned || false, created_at: now, updated_at: now,
  }).select().single();
  if (error) return c.json({ error: "Failed to add note" }, 500);

  await db.from("crm_customer_activity").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: id,
    actor_user_id: user.id, event_type: "note.added",
    event_data: { note_id: noteId, pinned: body.is_pinned || false }, created_at: now,
  });

  return c.json({ note }, 201);
});

// ── Soft Delete ───────────────────────────────────────────────────────────────
customers.delete("/:id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const user = c.get("user") as JwtPayload;
  const id = c.req.param("id");

  if (!["owner", "admin"].includes(c.get("workspace_role") || "")) {
    return c.json({ error: "Only owners and admins can delete customers" }, 403);
  }

  const now = nowIso();
  const { error } = await db.from("crm_customers").update({ deleted_at: now, updated_by: user.id }).eq("id", id).eq("workspace_id", workspaceId);
  if (error) return c.json({ error: "Failed to delete customer" }, 500);

  await db.from("crm_audit_log").insert({
    id: generateId(), workspace_id: workspaceId, actor_user_id: user.id,
    action: "customer.deleted", resource_type: "customer", resource_id: id,
    payload: {}, created_at: now,
  });

  return c.json({ deleted: true });
});

export default customers;
