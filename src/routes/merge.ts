// Loop CRM — Customer Merge Engine (with Rollback)
// LILCKY STUDIO LIMITED
// Merges two customer records into one primary, with full snapshot for rollback.

import { Hono } from "hono";
import type { Bindings, Variables } from "../index";
import { authMiddleware, workspaceMiddleware } from "../lib/middleware";
import { generateId, nowIso } from "../lib/auth";

const merge = new Hono<{ Bindings: Bindings; Variables: Variables }>();
merge.use("*", authMiddleware, workspaceMiddleware);

// Merge two customers — primary survives, secondary is absorbed
merge.post("/", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const user = c.get("user")!;

  if (!["owner", "admin"].includes(c.get("workspace_role") || "")) {
    return c.json({ error: "Only owners and admins can merge customers" }, 403);
  }

  const body = await c.req.json().catch(() => null) as {
    primary_id?: string; secondary_id?: string;
  } | null;
  if (!body?.primary_id || !body?.secondary_id) {
    return c.json({ error: "primary_id and secondary_id are required" }, 400);
  }
  if (body.primary_id === body.secondary_id) return c.json({ error: "Cannot merge a customer with itself" }, 400);

  // Load both customers
  const [{ data: primary }, { data: secondary }] = await Promise.all([
    db.from("crm_customers").select("*").eq("id", body.primary_id).eq("workspace_id", workspaceId).is("deleted_at", null).single(),
    db.from("crm_customers").select("*").eq("id", body.secondary_id).eq("workspace_id", workspaceId).is("deleted_at", null).single(),
  ]);
  if (!primary) return c.json({ error: "Primary customer not found" }, 404);
  if (!secondary) return c.json({ error: "Secondary customer not found" }, 404);

  const now = nowIso();
  const mergeLogId = generateId();

  // Snapshot the secondary before merge (enables rollback)
  const snapshot = { ...secondary };

  // Merge strategy:
  // - Primary keeps its name/email/phone unless null
  // - Tags are union
  // - Spend/counts are summed
  const mergedTags = [...new Set([
    ...(Array.isArray(primary.tags) ? primary.tags : []),
    ...(Array.isArray(secondary.tags) ? secondary.tags : []),
  ])];

  await db.from("crm_customers").update({
    tags: mergedTags,
    total_spend: (primary.total_spend || 0) + (secondary.total_spend || 0),
    conversation_count: (primary.conversation_count || 0) + (secondary.conversation_count || 0),
    booking_count: (primary.booking_count || 0) + (secondary.booking_count || 0),
    email: primary.email || secondary.email,
    phone: primary.phone || secondary.phone,
    company: primary.company || secondary.company,
    location: primary.location || secondary.location,
    last_seen_at: primary.last_seen_at > secondary.last_seen_at ? primary.last_seen_at : secondary.last_seen_at,
    updated_at: now,
    updated_by: user.id,
  }).eq("id", body.primary_id);

  // Re-point all secondary's channels to primary
  await db.from("crm_customer_channels")
    .update({ customer_id: body.primary_id })
    .eq("customer_id", body.secondary_id)
    .eq("workspace_id", workspaceId);

  // Re-point secondary's notes to primary
  await db.from("crm_customer_notes")
    .update({ customer_id: body.primary_id })
    .eq("customer_id", body.secondary_id)
    .eq("workspace_id", workspaceId);

  // Re-point secondary's activity to primary (preserve history)
  await db.from("crm_customer_activity")
    .update({ customer_id: body.primary_id })
    .eq("customer_id", body.secondary_id)
    .eq("workspace_id", workspaceId);

  // Remove secondary from segments
  await db.from("crm_customer_segment_members").delete().eq("customer_id", body.secondary_id);

  // Soft-delete the secondary, mark as merged
  await db.from("crm_customers").update({
    deleted_at: now, merged_into: body.primary_id, is_primary: false, updated_at: now,
  }).eq("id", body.secondary_id);

  // Create merge log (for rollback)
  await db.from("crm_customer_merge_log").insert({
    id: mergeLogId,
    workspace_id: workspaceId,
    primary_customer_id: body.primary_id,
    merged_customer_id: body.secondary_id,
    merge_snapshot: snapshot,
    merged_by: user.id,
    merged_at: now,
  });

  // Timeline events
  await db.from("crm_customer_activity").insert([
    {
      id: generateId(), workspace_id: workspaceId, customer_id: body.primary_id,
      actor_user_id: user.id, event_type: "merge.completed",
      event_data: { absorbed_customer_id: body.secondary_id, merge_log_id: mergeLogId },
      created_at: now,
    },
  ]);

  await db.from("crm_audit_log").insert({
    id: generateId(), workspace_id: workspaceId, actor_user_id: user.id,
    action: "customer.merged",
    resource_type: "customer",
    resource_id: body.primary_id,
    payload: { secondary_id: body.secondary_id, merge_log_id: mergeLogId },
    created_at: now,
  });

  return c.json({
    merged: true,
    primary_id: body.primary_id,
    absorbed_id: body.secondary_id,
    merge_log_id: mergeLogId,
    rollback_available: true,
  });
});

// Rollback a merge
merge.post("/rollback/:merge_log_id", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const user = c.get("user")!;
  const mergeLogId = c.req.param("merge_log_id");

  if (!["owner", "admin"].includes(c.get("workspace_role") || "")) {
    return c.json({ error: "Only owners and admins can roll back merges" }, 403);
  }

  const { data: log } = await db.from("crm_customer_merge_log")
    .select("*").eq("id", mergeLogId).eq("workspace_id", workspaceId).single();
  if (!log) return c.json({ error: "Merge log not found" }, 404);
  if (log.rolled_back_at) return c.json({ error: "This merge has already been rolled back" }, 409);

  const now = nowIso();
  const snapshot = log.merge_snapshot as Record<string, unknown>;

  // Restore the absorbed customer from snapshot
  await db.from("crm_customers").update({
    ...snapshot,
    deleted_at: null,
    merged_into: null,
    is_primary: true,
    updated_at: now,
    updated_by: user.id,
  }).eq("id", log.merged_customer_id);

  // Re-point channels back to secondary
  await db.from("crm_customer_channels")
    .update({ customer_id: log.merged_customer_id })
    .eq("customer_id", log.primary_customer_id)
    .eq("workspace_id", workspaceId);

  // Re-point notes back (best effort — activity stays on primary)
  await db.from("crm_customer_notes")
    .update({ customer_id: log.merged_customer_id })
    .eq("customer_id", log.primary_customer_id)
    .eq("workspace_id", workspaceId)
    .gt("created_at", log.merged_at);

  // Reverse the spend/count additions on primary
  const primarySnap = snapshot as Record<string, number>;
  await db.from("crm_customers").update({
    total_spend: db.rpc("max", [0, `total_spend - ${primarySnap.total_spend || 0}`]),
    updated_at: now,
  }).eq("id", log.primary_customer_id);

  // Mark merge log as rolled back
  await db.from("crm_customer_merge_log").update({ rolled_back_at: now, rolled_back_by: user.id }).eq("id", mergeLogId);

  // Timeline event
  await db.from("crm_customer_activity").insert({
    id: generateId(), workspace_id: workspaceId, customer_id: log.primary_customer_id,
    actor_user_id: user.id, event_type: "merge.rolled_back",
    event_data: { restored_customer_id: log.merged_customer_id, merge_log_id: mergeLogId },
    created_at: now,
  });

  await db.from("crm_audit_log").insert({
    id: generateId(), workspace_id: workspaceId, actor_user_id: user.id,
    action: "customer.merge_rolled_back", resource_type: "customer",
    resource_id: log.primary_customer_id,
    payload: { merge_log_id: mergeLogId, restored_id: log.merged_customer_id },
    created_at: now,
  });

  return c.json({ rolled_back: true, restored_customer_id: log.merged_customer_id });
});

// Get merge history
merge.get("/history", async (c) => {
  const db = c.get("db");
  const workspaceId = c.get("workspace_id")!;
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  const { data: logs } = await db.from("crm_customer_merge_log")
    .select("*").eq("workspace_id", workspaceId)
    .order("merged_at", { ascending: false }).limit(limit);

  return c.json({ merges: logs || [] });
});

export default merge;
