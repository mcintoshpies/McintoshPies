// Vercel serverless function: turns the pie cart into a Square checkout page.
// Needs these Environment Variables in Vercel (Settings → Environment Variables):
//   SQUARE_ACCESS_TOKEN   your Square access token (keep secret)
//   SQUARE_LOCATION_LR    Square location ID for Little Rock
//   SQUARE_LOCATION_NLR   Square location ID for North Little Rock
//   SQUARE_ENV            "sandbox" while testing, "production" when live
//   SITE_URL              https://www.mcintoshpies.com

const crypto = require("crypto");

// Prices are set HERE (in cents), so nobody can change them from their browser.
const MENU = {
  sweet:  { name: "Sweet Potato Pie – Thanksgiving Pre-Order",         cents: 1799 },
  pecan:  { name: "Pecan Pie – Thanksgiving Pre-Order",                cents: 1999 },
  cheese: { name: "Sweet Potato Cheesecake – Thanksgiving Pre-Order",  cents: 2699 },
  fill:   { name: "Sweet Potato Pie Filling – Thanksgiving Pre-Order", cents: 1399 },
};
const DAYS = { mon: "Monday, Nov 23", tue: "Tuesday, Nov 24", wed: "Wednesday, Nov 25" };
const CLOSES = Date.parse("2026-11-20T23:59:59-06:00"); // pre-orders close Fri Nov 20, 11:59 PM Central

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
  if (Date.now() > CLOSES) {
    return res.status(400).json({ error: "Thanksgiving pre-orders are closed." });
  }

  let body = req.body || {};
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { items, location, day, name, phone } = body;

  const loc = LOCATIONS[location];
  if (!loc || !loc.id) return res.status(400).json({ error: "Please choose where you'll pick up." });
  if (!DAYS[day]) return res.status(400).json({ error: "Please choose your pickup day." });

  const cleanName = String(name || "").trim().slice(0, 60);
  const cleanPhone = String(phone || "").replace(/[^\d+()\-\s]/g, "").trim().slice(0, 20);
  if (!cleanName) return res.status(400).json({ error: "Please enter your name." });
  if (cleanPhone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Please enter a 10-digit phone number." });

  const pickup = `Pickup ${DAYS[day]} at ${loc.name}`;
  const lineItems = [];
  for (const [key, qty] of Object.entries(items || {})) {
    const item = MENU[key];
    const q = parseInt(qty, 10);
    if (!item || !(q >= 1 && q <= 24)) continue;
    lineItems.push({
      name: item.name,
      quantity: String(q),
      base_price_money: { amount: item.cents, currency: "USD" },
      note: pickup,
    });
  }
  if (!lineItems.length) return res.status(400).json({ error: "Please add a pie to your order." });

  const note = `PIE PRE-ORDER · ${pickup} · ${cleanName} · ${cleanPhone}`;
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
