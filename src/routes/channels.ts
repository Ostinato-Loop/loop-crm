// Loop CRM — Customer Channel Routes (email, phone, WhatsApp, social)
// LILCKY STUDIO LIMITED

import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { authMiddleware, workspaceMiddleware } from "../lib/middleware";
import { generateId, nowIso } from "../lib/auth";
import type { JwtPayload } from "../lib/auth";

const channels = new Hono<{ Bindings: Bindings; Variables: Variables }>();
channels.use("*", authMiddleware, workspaceMiddleware);

const VALID_CHANNELS = ["email", "phone", "whatsapp", "instagram", "facebook", "twitter", "linkedin"];

// Link a channel to a customer
channels.post("/", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const user = c.get("user") as JwtPayload;
  const body = await c.req.json().catch(() => null) as {
    customer_id?: string; channel_type?: string; channel_id?: string; is_primary?: boolean;
  } | null;

  if (!body?.customer_id || !body.channel_type || !body.channel_id) {
    return c.json({ error: "customer_id, channel_type, and channel_id are required" }, 400);
  }
  if (!VALID_CHANNELS.includes(body.channel_type)) {
    return c.json({ error: `channel_type must be one of: ${VALID_CHANNELS.join(", ")}` }, 400);
  }

  // Verify customer belongs to workspace
  const { data: cust } = await db.from("crm_customers")
    .select("id").eq("id", body.customer_id).eq("workspace_id", workspaceId).is("deleted_at", null).single();
  if (!cust) return c.json({ error: "Customer not found" }, 404);

  // Check uniqueness within workspace
  const { data: existing } = await db.from("crm_customer_channels")
    .select("customer_id").eq("workspace_id", workspaceId)
    .eq("channel_type", body.channel_type).eq("channel_id", body.channel_id).single();
  if (existing) {
    if (existing.customer_id === body.customer_id) return c.json({ error: "Channel already linked to this customer" }, 409);
    return c.json({ error: "Channel already linked to a different customer — use merge to combine", existing_customer_id: existing.customer_id }, 409);
  }

  const now = nowIso();
  const { data: channel, error } = await db.from("crm_customer_channels").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: body.customer_id,
    channel_type: body.channel_type, channel_id: body.channel_id.toLowerCase().trim(),
    is_primary: body.is_primary || false, is_verified: false, created_at: now,
  }).select().single();
  if (error) return c.json({ error: "Failed to link channel" }, 500);

  await db.from("crm_customer_activity").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: body.customer_id,
    actor_user_id: user.id, event_type: "channel.linked",
    event_data: { channel_type: body.channel_type, channel_id: body.channel_id },
    created_at: now,
  });

  return c.json({ channel }, 201);
});

// List channels for a customer
channels.get("/customer/:customer_id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const customerId = c.req.param("customer_id");

  const { data: channels } = await db.from("crm_customer_channels")
    .select("*").eq("customer_id", customerId).eq("workspace_id", workspaceId)
    .order("is_primary", { ascending: false });

  return c.json({ channels: channels || [] });
});

// Mark channel as verified
channels.patch("/:id/verify", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const id = c.req.param("id");

  if (!["owner", "admin"].includes(c.get("workspace_role") || "")) {
    return c.json({ error: "Only owners and admins can verify channels" }, 403);
  }

  const now = nowIso();
  const { data: channel, error } = await db.from("crm_customer_channels")
    .update({ is_verified: true, verified_at: now })
    .eq("id", id).eq("workspace_id", workspaceId).select().single();
  if (error || !channel) return c.json({ error: "Channel not found" }, 404);

  return c.json({ channel });
});

// Remove channel
channels.delete("/:id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const id = c.req.param("id");

  if (!["owner", "admin"].includes(c.get("workspace_role") || "")) {
    return c.json({ error: "Only owners and admins can remove channels" }, 403);
  }

  const { error } = await db.from("crm_customer_channels").delete().eq("id", id).eq("workspace_id", workspaceId);
  if (error) return c.json({ error: "Failed to remove channel" }, 500);

  return c.json({ deleted: true });
});

// Lookup customer by channel (identity resolution)
channels.get("/resolve", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id") as string;
  const channelType = c.req.query("channel_type");
  const channelId = c.req.query("channel_id");

  if (!channelType || !channelId) return c.json({ error: "channel_type and channel_id required" }, 400);

  const { data: channel } = await db.from("crm_customer_channels")
    .select("*, crm_customers(*)")
    .eq("workspace_id", workspaceId).eq("channel_type", channelType)
    .eq("channel_id", channelId.toLowerCase().trim()).single();

  if (!channel) return c.json({ found: false, customer: null });
  return c.json({ found: true, customer: channel.crm_customers, channel });
});

export default channels;
