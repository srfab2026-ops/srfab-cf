// SR FAB cloth bill – Cloudflare Worker (login, bills in D1, PhonePe payments, backup)
const enc = new TextEncoder();
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/* ---------- crypto helpers (Web Crypto) ---------- */
const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); };
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(String(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function safeEq(a, b) {
  const x = await sha256hex(a), y = await sha256hex(b);
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
async function sign(env) {
  const p = b64u(enc.encode(JSON.stringify({ exp: Date.now() + 30 * 864e5 })));
  return p + "." + (await hmac(env.SESSION_SECRET, p));
}
async function tokenOk(req, env) {
  const t = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!t || !env.SESSION_SECRET) return false;
  const [p, m] = t.split(".");
  if (!p || !m) return false;
  if (!(await safeEq(await hmac(env.SESSION_SECRET, p), m))) return false;
  try { return JSON.parse(fromB64u(p)).exp > Date.now(); } catch { return false; }
}
const passOk = async (env, p) => !!env.SHOP_PASSWORD && (await safeEq(p || "", env.SHOP_PASSWORD));

/* ---------- small D1 helpers ---------- */
async function kvGet(env, k) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k=?").bind(k).first();
  return r ? r.v : null;
}
const kvSet = (env, k, v) =>
  env.DB.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, v);
const bump = (env) => kvSet(env, "ver", Date.now() + "-" + Math.floor(Math.random() * 1e6));
const upsertBill = (env, b) =>
  env.DB.prepare("INSERT INTO bills(t,data) VALUES(?,?) ON CONFLICT(t) DO UPDATE SET data=excluded.data").bind(b.t, JSON.stringify(b));

/* ---------- lock after 5 wrong passwords (60 s) ---------- */
async function locked(env) {
  const l = JSON.parse((await kvGet(env, "lock")) || '{"f":0,"u":0}');
  return l.u > Date.now();
}
async function noteTry(env, ok) {
  let l = JSON.parse((await kvGet(env, "lock")) || '{"f":0,"u":0}');
  if (ok) l = { f: 0, u: 0 };
  else { l.f++; if (l.f >= 5) { l.u = Date.now() + 60000; l.f = 0; } }
  await kvSet(env, "lock", JSON.stringify(l)).run();
}

/* ---------- validation ---------- */
const str = (v, n) => String(v == null ? "" : v).slice(0, n);
function cleanBill(b) {
  const t = Number(b && b.t), total = Number(b && b.total);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(total) || total <= 0) return null;
  const o = {
    t, m: b.m === "UPI" ? "UPI" : "Cash", total, sub: Number(b.sub) || total, d: Number(b.d) || 0,
    c: str(b.c, 80), w: str(b.w, 20),
    items: (Array.isArray(b.items) ? b.items : []).slice(0, 200).map((x) => ({
      n: str(x.n, 80), l: Number(x.l) || 0, r: Number(x.r) || 0, a: Number(x.a) || 0,
    })),
  };
  if (Number(b.no) > 0) o.no = Math.floor(Number(b.no));
  if (b.x) { o.x = 1; if (b.xt) o.xt = Number(b.xt) || 0; }
  return o;
}
function cleanConfig(c) {
  c = c || {};
  return {
    shop: str(c.shop, 80), upi: str(c.upi, 80), gst: str(c.gst, 20), addr: str(c.addr, 200),
    phone: str(c.phone, 20), link: str(c.link, 300),
    cloths: (Array.isArray(c.cloths) ? c.cloths : []).slice(0, 300)
      .map((x) => ({ n: str(x.n, 60), p: Number(x.p) || 0 })).filter((x) => x.n && x.p > 0),
  };
}
async function collect(env) {
  const ver = (await kvGet(env, "ver")) || "0";
  const cfg = await kvGet(env, "config");
  const { results } = await env.DB.prepare("SELECT data FROM bills ORDER BY t").all();
  return { ver, cfg, rows: results.map((r) => r.data) };
}

/* ---------- PhonePe ---------- */
const PP = (env) =>
  env.PHONEPE_ENV === "production"
    ? { auth: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token", pg: "https://api.phonepe.com/apis/pg" }
    : { auth: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token", pg: "https://api-preprod.phonepe.com/apis/pg-sandbox" };
let tokCache = { v: "", exp: 0 };
async function ppAuth(env) {
  if (tokCache.v && tokCache.exp > Date.now() + 60000) return tokCache.v;
  const r = await fetch(PP(env).auth, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.PHONEPE_CLIENT_ID || "",
      client_version: env.PHONEPE_CLIENT_VERSION || "1",
      client_secret: env.PHONEPE_CLIENT_SECRET || "",
      grant_type: "client_credentials",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error("PhonePe login failed – check Client ID, version and secret");
  const ex = Number(j.expires_at) || 0;
  tokCache = { v: "O-Bearer " + j.access_token, exp: ex ? (ex < 1e12 ? ex * 1000 : ex) : Date.now() + 600000 };
  return tokCache.v;
}
const ID_RE = /^SRF[0-9A-Za-z]{10,40}$/;

async function payCreate(req, env, body) {
  const amt = Number(body.amount);
  if (!Number.isFinite(amt) || amt < 1 || amt > 500000) return json({ error: "Bad amount" }, 400);
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  const id = "SRF" + Date.now() + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const origin = new URL(req.url).origin;
  const r = await fetch(PP(env).pg + "/checkout/v2/pay", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: await ppAuth(env) },
    body: JSON.stringify({
      merchantOrderId: id,
      amount: Math.round(amt * 100),
      expireAfter: 600,
      paymentFlow: { type: "PG_CHECKOUT", message: "SR FAB bill", merchantUrls: { redirectUrl: origin + "/thanks.html" } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.redirectUrl) return json({ error: j.message || j.code || "PhonePe could not create the payment" }, 502);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pay WHERE created<?").bind(Date.now() - 3 * 864e5),
    env.DB.prepare("INSERT INTO pay(id,state,amount,created,order_id) VALUES(?,?,?,?,?)")
      .bind(id, "PENDING", Math.round(amt * 100), Date.now(), j.orderId || ""),
  ]);
  return json({ merchantOrderId: id, redirectUrl: j.redirectUrl });
}
async function payStatus(env, id) {
  if (!ID_RE.test(id)) return json({ error: "Bad id" }, 400);
  const rec = await env.DB.prepare("SELECT state,amount FROM pay WHERE id=?").bind(id).first();
  if (!rec) return json({ error: "Unknown payment" }, 404);
  if (rec.state === "COMPLETED" || rec.state === "FAILED") return json({ state: rec.state });
  try {
    const r = await fetch(PP(env).pg + "/checkout/v2/order/" + id + "/status", { headers: { authorization: await ppAuth(env) } });
    const j = await r.json().catch(() => ({}));
    if (r.ok && (j.state === "COMPLETED" || j.state === "FAILED")) {
      if (j.state === "COMPLETED" && j.amount && Number(j.amount) !== rec.amount) return json({ state: "PENDING" });
      await env.DB.prepare("UPDATE pay SET state=? WHERE id=?").bind(j.state, id).run();
      return json({ state: j.state });
    }
  } catch { /* keep waiting */ }
  return json({ state: rec.state });
}
async function webhook(req, env) {
  const want = await sha256hex((env.PHONEPE_WEBHOOK_USER || "") + ":" + (env.PHONEPE_WEBHOOK_PASS || ""));
  const got = (req.headers.get("authorization") || "").trim().split(/\s+/).pop().toLowerCase();
  if (!env.PHONEPE_WEBHOOK_USER || !(await safeEq(got, want))) return json({ error: "unauthorized" }, 401);
  let b = {}; try { b = await req.json(); } catch { /* ignore */ }
  const p = b.payload || {}, id = p.merchantOrderId || p.originalMerchantOrderId || "";
  if (ID_RE.test(id)) {
    const rec = await env.DB.prepare("SELECT state,amount FROM pay WHERE id=?").bind(id).first();
    if (rec) {
      if (/completed/i.test(b.event || "") && p.state === "COMPLETED" && (!p.amount || Number(p.amount) === rec.amount))
        await env.DB.prepare("UPDATE pay SET state='COMPLETED' WHERE id=?").bind(id).run();
      else if (/failed/i.test(b.event || "") && rec.state !== "COMPLETED")
        await env.DB.prepare("UPDATE pay SET state='FAILED' WHERE id=?").bind(id).run();
    }
  }
  return json({ ok: true });
}

/* ---------- router ---------- */
async function handle(req, env) {
  const path = new URL(req.url).pathname.replace(/^\/api\/?/, "");
  const method = req.method;
  try {
    if (path === "phonepe/webhook" && method === "POST") return await webhook(req, env);

    if (path === "login" && method === "POST") {
      if (!env.SESSION_SECRET || !env.SHOP_PASSWORD || !env.SHOP_MOBILE) return json({ error: "Server not set up" }, 500);
      if (await locked(env)) return json({ error: "locked" }, 429);
      const b = await req.json().catch(() => ({}));
      const mob = String(b.mobile || "").replace(/\D/g, "").slice(-10);
      const ok = (await safeEq(mob, String(env.SHOP_MOBILE).replace(/\D/g, "").slice(-10))) && (await passOk(env, b.password));
      await noteTry(env, ok);
      return ok ? json({ token: await sign(env) }) : json({ error: "bad login" }, 401);
    }

    if (path === "backup" && method === "GET") {
      const key = req.headers.get("x-backup-key") || "";
      const viaKey = !!env.BACKUP_KEY && env.BACKUP_KEY.length >= 16 && !!key && (await safeEq(key, env.BACKUP_KEY));
      if (!viaKey && !(await tokenOk(req, env))) return json({ error: "not allowed" }, 401);
      const c = await collect(env);
      const body = '{"app":"srfab","version":1,"exportedAt":' + JSON.stringify(new Date().toISOString()) +
        ',"config":' + (c.cfg || "null") + ',"bills":[' + c.rows.join(",") + "]}";
      return new Response(body, {
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="srfab-backup-' + new Date().toISOString().slice(0, 10) + '.json"',
          "cache-control": "no-store",
        },
      });
    }

    if (!(await tokenOk(req, env))) return json({ error: "login required" }, 401);

    if (path === "verify" && method === "POST") {
      if (await locked(env)) return json({ error: "locked" }, 429);
      const b = await req.json().catch(() => ({}));
      const ok = await passOk(env, b.password);
      await noteTry(env, ok);
      return ok ? json({ ok: true }) : json({ error: "wrong password" }, 403);
    }
    if (path === "sig" && method === "GET") return json({ ver: (await kvGet(env, "ver")) || "0" });

    if (path === "data" && method === "GET") {
      const c = await collect(env);
      return new Response('{"ver":' + JSON.stringify(c.ver) + ',"config":' + (c.cfg || "null") + ',"bills":[' + c.rows.join(",") + "]}",
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (path === "config" && method === "PUT") {
      const cfg = cleanConfig(await req.json().catch(() => ({})));
      await env.DB.batch([kvSet(env, "config", JSON.stringify(cfg)), bump(env)]);
      return json({ ok: true });
    }
    if (path === "bill" && method === "PUT") {
      const b = cleanBill(await req.json().catch(() => ({})));
      if (!b) return json({ error: "bad bill" }, 400);
      await env.DB.batch([upsertBill(env, b), bump(env)]);
      return json({ ok: true });
    }
    if (path === "bill/delete" && method === "POST") {
      const ids = ((await req.json().catch(() => ({}))).ids || []).map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(0, 500);
      const st = [];
      for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        st.push(env.DB.prepare("DELETE FROM bills WHERE t IN (" + part.map(() => "?").join(",") + ")").bind(...part));
      }
      if (st.length) { st.push(bump(env)); await env.DB.batch(st); }
      return json({ ok: true });
    }
    if (path === "restore" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (!b || b.app !== "srfab" || !Array.isArray(b.bills) || b.bills.length > 300) return json({ error: "send at most 300 bills at a time" }, 400);
      const st = [];
      let n = 0;
      b.bills.forEach((x) => { const c = cleanBill(x); if (c) { st.push(upsertBill(env, c)); n++; } });
      if (b.config) st.push(kvSet(env, "config", JSON.stringify(cleanConfig(b.config))));
      if (st.length) { st.push(bump(env)); await env.DB.batch(st); }
      return json({ ok: true, bills: n });
    }
    if (path === "pay/create" && method === "POST") return await payCreate(req, env, await req.json().catch(() => ({})));
    if (path.startsWith("pay/status/") && method === "GET") return await payStatus(env, decodeURIComponent(path.slice(11)));

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: "Server error: " + (e && e.message ? e.message : "unknown") }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handle(request, env);
    return env.ASSETS.fetch(request);
  },
};
