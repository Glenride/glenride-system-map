// Glenride System Map API — Cloudflare Worker + shared D1 (glenride-hq).
// Independent rebuild of the Muse `glenride-system-map` artifact.
// The Muse original stays live and untouched; this is a rebuild, not a migration.
//
// Auth: single shared password (Worker secret APP_PASSWORD). POST /api/login
// mints an HMAC session token (30 days), returned in JSON and set as an
// HttpOnly cookie. Every other route 401s without a valid token (Bearer or
// cookie). The org structure and budgets are internal and must not be public.
//
// Original Muse actions rebuilt here (also exposed as POST /api/action):
//   getmap, adddepartment, updatedepartment, deletedepartment,
//   updatebudgetstage, updatehierarchycard, updateorganization

const ALLOWED_ORIGINS = [
  "https://map.dvaughnhouse.com",
  "https://glenride-system-map.pages.dev",
  "http://localhost:8787",
  "http://localhost:8080",
];

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64url = (s) => atob(s.replaceAll("-", "+").replaceAll("_", "/"));

function timingSafeStrEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSig(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

async function makeToken(secret) {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    exp: Date.now() + 30 * 864e5, r: crypto.randomUUID(),
  })));
  return `${payload}.${await hmacSig(payload, secret)}`;
}

async function verifyToken(token, secret) {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expect = await hmacSig(payload, secret);
  if (!timingSafeStrEq(sig, expect)) return false;
  try {
    const data = JSON.parse(unb64url(payload));
    return data.exp > Date.now();
  } catch { return false; }
}

async function authorized(req, env) {
  const secret = env.APP_PASSWORD;
  if (!secret) return false;
  const auth = req.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (bearer && timingSafeStrEq(bearer, secret)) return true; // raw password as Bearer (machine use)
  const cookie = req.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)sysmap_session=([^;]+)/);
  const token = (m && decodeURIComponent(m[1])) || bearer;
  return verifyToken(token, secret);
}

const sessionCookie = (token) =>
  `sysmap_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=2592000`;
const clearSessionCookie =
  "sysmap_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0";

// --- Field whitelists (updates may only touch these columns) ---
const DEPT_FIELDS = ["title", "tagline", "mandate", "cost_center", "current_state",
  "future_state", "done_looks_like", "notes", "accent", "is_core", "sort_order"];
const STAGE_FIELDS = ["title", "description", "timing", "decision_rule", "sort_order"];
const HIER_FIELDS = ["title", "holder", "responsibility", "sort_order"];
const ORG_FIELDS = ["premise", "current_title", "current_body", "future_title", "future_body"];

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}
function normDept(r) {
  return { ...r, is_core: r.is_core === 1 || r.is_core === true };
}
const now = () => new Date().toISOString();

async function getMap(db) {
  const departments = (await db.prepare(
    "SELECT * FROM sysmap_departments ORDER BY sort_order, id").all()).results.map(normDept);
  const budget_stages = (await db.prepare(
    "SELECT * FROM sysmap_budget_stages ORDER BY sort_order, id").all()).results;
  const hierarchy = (await db.prepare(
    "SELECT * FROM sysmap_hierarchy ORDER BY sort_order, id").all()).results;
  const org = await db.prepare("SELECT * FROM sysmap_organization WHERE id = 1").first();
  return { departments, budget_stages, hierarchy, organization: org || null };
}

async function updateRow(db, table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return null;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const vals = keys.map((k) =>
    k === "is_core" ? (fields[k] ? 1 : 0) : fields[k]);
  await db.prepare(
    `UPDATE ${table} SET ${sets}, updated_at = ? WHERE id = ?`
  ).bind(...vals, now(), id).run();
  const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
  return row ? (table === "sysmap_departments" ? normDept(row) : row) : null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = corsHeaders(req);
    const withCors = (res) => {
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    };

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // Public: health + login
    if (path === "/api/health" && req.method === "GET")
      return withCors(json({ ok: true, service: "glenride-system-map-api" }));

    if (path === "/api/login" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch { return withCors(json({ ok: false, error: "bad json" }, 400)); }
      const secret = env.APP_PASSWORD;
      if (secret && body.password && timingSafeStrEq(String(body.password), secret)) {
        const token = await makeToken(secret);
        return withCors(json({ ok: true, token }, 200, { "Set-Cookie": sessionCookie(token) }));
      }
      return withCors(json({ ok: false, error: "wrong password" }, 401));
    }

    if (path === "/api/logout" && req.method === "POST")
      return withCors(json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie }));

    // Everything below requires auth
    if (!(await authorized(req, env)))
      return withCors(json({ ok: false, error: "unauthorized" }, 401));

    const db = env.SYSMAP_DB;

    // GET /api/map — the original `getmap` action
    if (path === "/api/map" && req.method === "GET")
      return withCors(json(await getMap(db)));

    // POST /api/action — original Muse action names, for faithfulness
    if (path === "/api/action" && req.method === "POST") {
      let body = {};
      try { body = await req.json(); } catch { return withCors(json({ ok: false, error: "bad json" }, 400)); }
      const action = String(body.action || "");
      try {
        if (action === "getmap") return withCors(json(await getMap(db)));
        if (action === "adddepartment") {
          const f = pick(body, DEPT_FIELDS);
          if (!f.title) return withCors(json({ ok: false, error: "title required" }, 400));
          const r = await db.prepare("SELECT MAX(id) AS m FROM sysmap_departments").first();
          const id = (r && r.m ? r.m : 0) + 1;
          const row = { id, title: f.title, tagline: f.tagline || "", mandate: f.mandate || "",
            cost_center: f.cost_center || "", current_state: f.current_state || "",
            future_state: f.future_state || "", done_looks_like: f.done_looks_like || "",
            notes: f.notes || "", accent: f.accent || "ember",
            is_core: f.is_core === undefined ? 1 : (f.is_core ? 1 : 0),
            sort_order: f.sort_order ?? 99, updated_at: now() };
          await db.prepare(
            `INSERT INTO sysmap_departments
             (id, title, tagline, mandate, cost_center, current_state, future_state,
              done_looks_like, notes, accent, is_core, sort_order, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(row.id, row.title, row.tagline, row.mandate, row.cost_center,
            row.current_state, row.future_state, row.done_looks_like, row.notes,
            row.accent, row.is_core, row.sort_order, row.updated_at).run();
          return withCors(json(normDept(row), 201));
        }
        if (action === "updatedepartment") {
          const row = await updateRow(db, "sysmap_departments", Number(body.id), pick(body, DEPT_FIELDS));
          return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
        }
        if (action === "deletedepartment") {
          await db.prepare("DELETE FROM sysmap_departments WHERE id = ?").bind(Number(body.id)).run();
          return withCors(json({ ok: true, id: Number(body.id) }));
        }
        if (action === "updatebudgetstage") {
          const row = await updateRow(db, "sysmap_budget_stages", Number(body.id), pick(body, STAGE_FIELDS));
          return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
        }
        if (action === "updatehierarchycard") {
          const row = await updateRow(db, "sysmap_hierarchy", Number(body.id), pick(body, HIER_FIELDS));
          return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
        }
        if (action === "updateorganization") {
          const row = await updateRow(db, "sysmap_organization", 1, pick(body, ORG_FIELDS));
          return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
        }
        return withCors(json({ ok: false, error: "unknown action" }, 400));
      } catch (err) {
        return withCors(json({ ok: false, error: String(err && err.message ? err.message : err) }, 500));
      }
    }

    // --- REST routes (same operations, resource-shaped) ---
    const mDept = path.match(/^\/api\/departments(?:\/(\d+))?$/);
    if (mDept) {
      const id = mDept[1] ? Number(mDept[1]) : null;
      if (req.method === "GET" && id === null) {
        const rows = (await db.prepare("SELECT * FROM sysmap_departments ORDER BY sort_order, id").all()).results;
        return withCors(json(rows.map(normDept)));
      }
      if (req.method === "POST" && id === null) {
        let body = {};
        try { body = await req.json(); } catch { return withCors(json({ ok: false, error: "bad json" }, 400)); }
        const f = pick(body, DEPT_FIELDS);
        if (!f.title) return withCors(json({ ok: false, error: "title required" }, 400));
        const r = await db.prepare("SELECT MAX(id) AS m FROM sysmap_departments").first();
        const nid = (r && r.m ? r.m : 0) + 1;
        const row = { id: nid, title: f.title, tagline: f.tagline || "", mandate: f.mandate || "",
          cost_center: f.cost_center || "", current_state: f.current_state || "",
          future_state: f.future_state || "", done_looks_like: f.done_looks_like || "",
          notes: f.notes || "", accent: f.accent || "ember",
          is_core: f.is_core === undefined ? 1 : (f.is_core ? 1 : 0),
          sort_order: f.sort_order ?? 99, updated_at: now() };
        await db.prepare(
          `INSERT INTO sysmap_departments
           (id, title, tagline, mandate, cost_center, current_state, future_state,
            done_looks_like, notes, accent, is_core, sort_order, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(row.id, row.title, row.tagline, row.mandate, row.cost_center,
          row.current_state, row.future_state, row.done_looks_like, row.notes,
          row.accent, row.is_core, row.sort_order, row.updated_at).run();
        return withCors(json(normDept(row), 201));
      }
      if (req.method === "PATCH" && id !== null) {
        let body = {};
        try { body = await req.json(); } catch { return withCors(json({ ok: false, error: "bad json" }, 400)); }
        const row = await updateRow(db, "sysmap_departments", id, pick(body, DEPT_FIELDS));
        return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
      }
      if (req.method === "DELETE" && id !== null) {
        await db.prepare("DELETE FROM sysmap_departments WHERE id = ?").bind(id).run();
        return withCors(json({ ok: true, id }));
      }
      return withCors(json({ ok: false, error: "method not allowed" }, 405));
    }

    const mStage = path.match(/^\/api\/budget-stages(?:\/(\d+))?$/);
    if (mStage) {
      const id = mStage[1] ? Number(mStage[1]) : null;
      if (req.method === "GET" && id === null) {
        const rows = (await db.prepare("SELECT * FROM sysmap_budget_stages ORDER BY sort_order, id").all()).results;
        return withCors(json(rows));
      }
      if (req.method === "PATCH" && id !== null) {
        let body = {};
        try { body = await req.json(); } catch { return withCors(json({ ok: false, error: "bad json" }, 400)); }
        const row = await updateRow(db, "sysmap_budget_stages", id, pick(body, STAGE_FIELDS));
        return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
      }
      return withCors(json({ ok: false, error: "method not allowed" }, 405));
    }

    const mHier = path.match(/^\/api\/hierarchy(?:\/(\d+))?$/);
    if (mHier) {
      const id = mHier[1] ? Number(mHier[1]) : null;
      if (req.method === "GET" && id === null) {
        const rows = (await db.prepare("SELECT * FROM sysmap_hierarchy ORDER BY sort_order, id").all()).results;
        return withCors(json(rows));
      }
      if (req.method === "PATCH" && id !== null) {
        let body = {};
        try { body = await req.json(); } catch { return withCors(json({ ok: false, error: "bad json" }, 400)); }
        const row = await updateRow(db, "sysmap_hierarchy", id, pick(body, HIER_FIELDS));
        return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
      }
      return withCors(json({ ok: false, error: "method not allowed" }, 405));
    }

    if (path === "/api/organization") {
      if (req.method === "GET") {
        const row = await db.prepare("SELECT * FROM sysmap_organization WHERE id = 1").first();
        return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
      }
      if (req.method === "PATCH") {
        let body = {};
        try { body = await req.json(); } catch { return withCors(json({ ok: false, error: "bad json" }, 400)); }
        const row = await updateRow(db, "sysmap_organization", 1, pick(body, ORG_FIELDS));
        return row ? withCors(json(row)) : withCors(json({ ok: false, error: "not found" }, 404));
      }
      return withCors(json({ ok: false, error: "method not allowed" }, 405));
    }

    return withCors(json({ ok: false, error: "not found" }, 404));
  },
};
