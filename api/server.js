// VitaPlan API: stores questionnaire leads in Neon Postgres
const http = require("http");
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ORIGINS = (process.env.ALLOWED_ORIGINS || "https://vitaplan.onrender.com").split(",");
const hits = new Map();

function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.includes(o) || /^http:\/\/localhost(:\d+)?$/.test(o))) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-admin-key");
}
function send(res, code, obj) { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, bad) => { let d = ""; req.on("data", c => { d += c; if (d.length > 300000) { bad(new Error("too large")); req.destroy(); } }); req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch (e) { bad(e); } }); });
}
function limited(ip) {
  const now = Date.now(), w = hits.get(ip) || [];
  const recent = w.filter(t => now - t < 60000); recent.push(now); hits.set(ip, recent);
  return recent.length > 60;
}
const STAGES = ["started", "in_progress", "completed", "submitted"];

http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname === "/api/save" && req.method === "POST") {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress;
      if (limited(ip)) return send(res, 429, { ok: false });
      const b = await body(req);
      if (typeof b.cid !== "string" || !/^[\w-]{8,64}$/.test(b.cid)) return send(res, 400, { ok: false, err: "cid" });
      const phone = String(b.phone || "").replace(/[^\d+]/g, "").slice(0, 16);
      if (!/^(\+98|0)?9\d{9}$/.test(phone)) return send(res, 400, { ok: false, err: "phone" });
      const stage = STAGES.includes(b.stage) ? b.stage : "started";
      await pool.query(
        `INSERT INTO leads (cid,name,phone,age,sex,stage,plan,needs_review,data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (cid) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, age=EXCLUDED.age, sex=EXCLUDED.sex,
           stage=CASE WHEN array_position($10::text[],leads.stage) > array_position($10::text[],EXCLUDED.stage) THEN leads.stage ELSE EXCLUDED.stage END,
           plan=COALESCE(EXCLUDED.plan,leads.plan), needs_review=EXCLUDED.needs_review OR leads.needs_review,
           data=leads.data || EXCLUDED.data, updated_at=now()`,
        [b.cid, String(b.name || "").slice(0, 120), phone, Number(b.age) || null, b.sex === "f" || b.sex === "m" ? b.sex : null,
         stage, b.plan ? String(b.plan).slice(0, 40) : null, !!b.needsReview, b.data && typeof b.data === "object" ? b.data : {}, STAGES]);
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/leads" && req.method === "GET") {
      if (!ADMIN_KEY || req.headers["x-admin-key"] !== ADMIN_KEY) return send(res, 401, { ok: false });
      const r = await pool.query("SELECT * FROM leads ORDER BY updated_at DESC LIMIT 1000");
      return send(res, 200, { ok: true, rows: r.rows });
    }
    send(res, 404, { ok: false });
  } catch (e) { console.error(e); send(res, 500, { ok: false }); }
}).listen(process.env.PORT || 10000, () => console.log("vitaplan api up"));
