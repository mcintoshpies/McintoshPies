// Vercel serverless function: turns a pie order into a Square checkout page.
// Needs these Environment Variables in Vercel (Settings → Environment Variables):
//   SQUARE_ACCESS_TOKEN   your Square access token (keep secret)
//   SQUARE_LOCATION_LR    Square location ID for Little Rock
//   SQUARE_LOCATION_NLR   Square location ID for North Little Rock
//   SQUARE_ENV            "sandbox" while testing, "production" when live
//   SITE_URL              https://www.mcintoshpies.com

const crypto = require("crypto");

// Prices are set HERE (in cents), so nobody can change them from their browser.
const MENU = {
  sweet:  { name: "Sweet Potato Pie – Online Order",         cents: 1999 },
  pecan:  { name: "Pecan Pie – Online Order",                cents: 2299 },
  cheese: { name: "Sweet Potato Cheesecake – Online Order",  cents: 2999 },
  fill:   { name: "Sweet Potato Pie Filling – Online Order", cents: 1599 },
};
// Sales tax by location (percent, as text)
const TAX = { lr: "10.625", nlr: "9.5" };
const SLOTS = { early: "11am–2pm", mid: "2pm–5pm", late: "5pm–8pm" };

// PICKUP DAYS: keep in sync with index.html.
// Pickup starts tomorrow (24 hours to bake). Closed Sundays and on the dates below.
const CLOSED = ["2026-11-26"]; // add holiday closures here as "YYYY-MM-DD"
const SHOW_DAYS = 30; // offer pickup days across the next 30 days

// Open pickup days (YYYY-MM-DD) in Little Rock time
function openDays() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 12));
  const out = [];
  for (let i = 0; i < SHOW_DAYS; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (d.getUTCDay() === 0 || CLOSED.includes(iso)) continue;
    out.push(iso);
  }
  return out;
}
const niceDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" });

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const env = process.env;
  const LOCATIONS = {
    lr:  { id: env.SQUARE_LOCATION_LR,  name: "Little Rock" },
    nlr: { id: env.SQUARE_LOCATION_NLR, name: "North Little Rock" },
  };
  if (!env.SQUARE_ACCESS_TOKEN) {
    return res.status(500).json({ error: "Online checkout isn't set up yet. Please check back soon." });
  }

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { items, location, day, slot, name, phone } = body;

  const loc = LOCATIONS[location];
  if (!loc || !loc.id) return res.status(400).json({ error: "Please choose where you'll pick up." });
  if (!openDays().includes(day)) return res.status(400).json({ error: "That pickup day isn't available anymore. Please choose another day." });
  if (!SLOTS[slot]) return res.status(400).json({ error: "Please choose a pickup time." });
  const pickup = `Pickup ${niceDate(day)}, ${SLOTS[slot]} at ${loc.name}`;

  const cleanName = String(name || "").trim().slice(0, 60);
  const cleanPhone = String(phone || "").replace(/[^\d+()\-\s]/g, "").trim().slice(0, 20);
  if (!cleanName) return res.status(400).json({ error: "Please enter your name." });
  if (cleanPhone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Please enter a 10-digit phone number." });

  const lineNote = `${pickup} · ${cleanName} · ${cleanPhone}`.slice(0, 500);
  const lineItems = [];
  for (const [key, qty] of Object.entries(items || {})) {
    const item = MENU[key];
    const q = parseInt(qty, 10);
    if (!item || !(q >= 1 && q <= 24)) continue;
    lineItems.push({
      name: item.name,
      quantity: String(q),
      base_price_money: { amount: item.cents, currency: "USD" },
      note: lineNote, // pickup + customer name + phone (read by the dashboard)
      metadata: { pickup_date: day, slot }, // read by the dashboard
    });
  }
  if (!lineItems.length) return res.status(400).json({ error: "Please add a pie to your order." });

  const note = `PIE ORDER · ${pickup} · ${cleanName} · ${cleanPhone}`;
  const base = env.SQUARE_ENV === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
  const site = (env.SITE_URL || "https://www.mcintoshpies.com").replace(/\/$/, "");

  try {
    const r = await fetch(base + "/v2/online-checkout/payment-links", {
      method: "POST",
      headers: {
        "Square-Version": "2024-10-17",
        "Authorization": "Bearer " + env.SQUARE_ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        payment_note: note.slice(0, 500),
        order: {
          location_id: loc.id,
          ticket_name: ("Pies – " + cleanName).slice(0, 30),
          line_items: lineItems,
          taxes: [{ uid: "sales-tax", name: "Sales Tax", percentage: TAX[location], scope: "ORDER" }],
        },
        checkout_options: {
          redirect_url: site + "/?ordered=1",
          ask_for_shipping_address: false,
          allow_tipping: false,
        },
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.payment_link || !data.payment_link.url) {
      console.error("Square error:", JSON.stringify(data.errors || data));
      return res.status(502).json({ error: "We couldn't open checkout. Please try again in a minute." });
    }
    return res.status(200).json({ url: data.payment_link.url });
  } catch (e) {
    console.error("Checkout failed:", e);
    return res.status(502).json({ error: "We couldn't open checkout. Please try again in a minute." });
  }
};
