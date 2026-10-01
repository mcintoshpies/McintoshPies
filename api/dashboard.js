// Vercel serverless function: reads paid pie orders from Square and counts them
// for the private dashboard at /dashboard.
// Uses the same Square settings as api/checkout.js, plus:
//   DASHBOARD_PASSWORD   the password staff type to open the dashboard

const crypto = require("crypto");

const PIES = [
  { key: "sweet",  starts: "Sweet Potato Pie –" },
  { key: "pecan",  starts: "Pecan Pie –" },
  { key: "cheese", starts: "Sweet Potato Cheesecake –" },
  { key: "fill",   starts: "Sweet Potato Pie Filling –" },
];
const DAYS = [
  { key: "mon", label: "Monday, Nov 23" },
  { key: "tue", label: "Tuesday, Nov 24" },
  { key: "wed", label: "Wednesday, Nov 25" },
];
const START = "2026-09-01T00:00:00Z"; // only look at orders placed after this date

const blank = () => ({ sweet: 0, pecan: 0, cheese: 0, fill: 0 });

function samePassword(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Little Rock calendar date (YYYY-MM-DD) for a timestamp
function chicagoDate(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
// Ready-tomorrow pickup date for an order placed at `created`: next day, skipping Sunday
function readyDateISO(created) {
  const [y, m, d] = chicagoDate(new Date(created)).split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1, 12));
  if (t.getUTCDay() === 0) t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
function niceDate(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const env = process.env;
  if (!env.DASHBOARD_PASSWORD) return res.status(500).json({ error: "Add DASHBOARD_PASSWORD in Vercel to turn on the dashboard." });
  if (!samePassword(req.headers["x-dashboard-password"], env.DASHBOARD_PASSWORD)) {
    return res.status(401).json({ error: "Wrong password." });
  }
  if (!env.SQUARE_ACCESS_TOKEN) return res.status(500).json({ error: "Square isn't connected yet." });

  const LOCS = { [env.SQUARE_LOCATION_LR]: "lr", [env.SQUARE_LOCATION_NLR]: "nlr" };
  const base = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";

  // 1. Pull every paid order from both locations
  const orders = [];
  let cursor;
  try {
    for (let page = 0; page < 20; page++) {
      const r = await fetch(base + "/v2/orders/search", {
        method: "POST",
        headers: { "Square-Version": "2024-10-17", "Authorization": "Bearer " + env.SQUARE_ACCESS_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          location_ids: [env.SQUARE_LOCATION_LR, env.SQUARE_LOCATION_NLR].filter(Boolean),
          limit: 500,
          cursor,
          query: {
            filter: {
              state_filter: { states: ["OPEN", "COMPLETED"] },
              date_time_filter: { created_at: { start_at: START } },
            },
            sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
          },
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        console.error("Square error:", JSON.stringify(data.errors || data));
        return res.status(502).json({ error: "Couldn't read orders from Square. Try again in a minute." });
      }
      orders.push(...(data.orders || []));
      cursor = data.cursor;
      if (!cursor) break;
    }
  } catch (e) {
    console.error("Dashboard failed:", e);
    return res.status(502).json({ error: "Couldn't read orders from Square. Try again in a minute." });
  }

  // 2. Count pies
  const pre = {};
  DAYS.forEach((d) => (pre[d.key] = { label: d.label, lr: blank(), nlr: blank(), list: [] }));
  const tom = {}; // by pickup date
  let paid = 0, refunded = 0;
  const today = chicagoDate(new Date());

  for (const o of orders) {
    if (!o.tenders || !o.tenders.length) continue; // not paid
    if ((o.refunds || []).some((x) => x.status !== "REJECTED" && x.status !== "FAILED")) { refunded++; continue; }
    const loc = LOCS[o.location_id];
    if (!loc) continue;

    let counted = false;
    const items = [];
    for (const li of o.line_items || []) {
      const name = li.name || "";
      const pie = PIES.slice().sort((a, b) => b.starts.length - a.starts.length).find((p) => name.startsWith(p.starts));
      if (!pie) continue;
      const q = parseInt(li.quantity, 10) || 0;
      const note = li.note || "";

      if (name.includes("Thanksgiving Pre-Order")) {
        const day = DAYS.find((d) => note.includes(d.label));
        if (!day) continue;
        pre[day.key][loc][pie.key] += q;
        items.push({ kind: "pre", day: day.key, pie: pie.key, q });
        counted = true;
      } else if (name.includes("Ready Tomorrow")) {
        const iso = readyDateISO(o.created_at);
        if (iso < today) continue; // already picked up
        const slot = (note.match(/(11am–2pm|2pm–5pm|5pm–8pm)/) || [])[1] || "";
        tom[iso] = tom[iso] || { label: niceDate(iso), lr: blank(), nlr: blank(), list: [] };
        tom[iso][loc][pie.key] += q;
        items.push({ kind: "tom", iso, slot, pie: pie.key, q });
        counted = true;
      }
    }
    if (!counted) continue;
    paid++;

    // customer name + phone are saved in each item's note: "Pickup … · Name · Phone"
    const parts = ((o.line_items || []).map((l) => l.note || "").find((n) => n.split(" · ").length >= 3) || "").split(" · ");
    const who = parts.length >= 3 ? parts[1] : (o.ticket_name || "").replace(/^Pies – /, "");
    const phone = parts.length >= 3 ? parts[2] : "";
    const byGroup = {};
    for (const it of items) {
      const g = it.kind === "pre" ? "pre:" + it.day : "tom:" + it.iso;
      (byGroup[g] = byGroup[g] || { slot: it.slot, pies: blank() }).pies[it.pie] += it.q;
    }
    for (const [g, v] of Object.entries(byGroup)) {
      const entry = { name: who || "Customer", phone, loc, slot: v.slot || "", pies: v.pies };
      const [kind, id] = g.split(":");
      (kind === "pre" ? pre[id] : tom[id]).list.push(entry);
    }
  }

  const tomorrow = Object.keys(tom).sort().map((k) => ({ date: k, ...tom[k] }));
  return res.status(200).json({ updated: new Date().toISOString(), paid, refunded, preorder: pre, tomorrow });
};
