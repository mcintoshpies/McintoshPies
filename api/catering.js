// Vercel serverless function: emails a catering request from /catering to the restaurant.
// Nothing is charged here. Staff confirm the order, then send the customer a Square payment link or invoice.
//
// Needs these Environment Variables in Vercel (Settings → Environment Variables):
//   RESEND_API_KEY   API key from resend.com (keep secret)
//   CATERING_TO      where requests go (default: pies@mcintoshpies.com)
//   CATERING_FROM    the "from" address, e.g. "Say McIntosh Catering <pies@mcintoshpies.com>"
//                    (the domain must be verified in Resend; until then the default below only
//                    delivers to the email address you signed up to Resend with)

// Menu and prices are set HERE, so the estimate in the email can't be changed from a browser.
const PER_PERSON = { boxed: 1500, buffet: 1999 }; // cents: starting prices for boxed lunch and buffet
const ADDONS = {
  pie:      { name: "Whole Sweet Potato Pie", cents: 1999 },
  lemonade: { name: "Gallon of Lemonade",     cents: 1499 },
};
const PACKAGES = {
  boxed:   "Boxed Lunch (from $15.00/person)",
  buffet:  "Southern Style Buffet (from $19.99/person)",
};
const BOXED = ["Cheeseburger", "Turkey Burger", "Grilled Chicken Sandwich", "2-Piece Fried Catfish"];
const ENTREES = ["Fried Catfish", "Fried Chicken", "Barbecue Chicken", "BBQ Pulled Chicken", "Sliced BBQ Beef", "BBQ Hot Links", "Grilled Chicken Breast", "Chicken & Dressing"];
const SIDES = ["Greens", "Candied Yams", "Purple Hull Peas & Okra", "Green Beans", "Barbecue Beans", "Corn on the Cob", "Potato Salad", "Coleslaw"];
const RESTAURANT = "Little Rock · 6223 Colonel Glenn Rd"; // all catering is handled by Little Rock
const METHODS = {
  delivery: "Delivery within 15 miles (included)",
  far:      "Delivery more than 15 miles (additional fee, needs a quote)",
  pickup:   "Pickup at Little Rock (6223 Colonel Glenn Rd)",
};

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
const pick = (list, allowed) => (Array.isArray(list) ? list : []).map(String).filter((x) => allowed.includes(x));
const money = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function todayChicago() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const env = process.env;
  if (!env.RESEND_API_KEY) {
    return res.status(500).json({ error: "Online catering requests aren't set up yet. Please email pies@mcintoshpies.com." });
  }

  let b = req.body || {};
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (e) { b = {}; } }

  // Spam trap: real people never fill in this hidden field.
  if (clean(b.website, 200)) return res.status(200).json({ ok: true });

  const pkg = PACKAGES[b.package] ? b.package : "";
  if (!pkg) return res.status(400).json({ error: "Please choose what you'd like to order." });

  const name = clean(b.name, 80);
  const org = clean(b.org, 120);
  const phone = clean(b.phone, 20).replace(/[^\d+()\-\s.]/g, "");
  const email = clean(b.email, 120);
  const date = clean(b.date, 10);
  const time = clean(b.time, 5);
  const notes = clean(b.notes, 1500);
  const method = METHODS[b.method] ? b.method : "";
  const street = clean(b.street, 150), city = clean(b.city, 60), zip = clean(b.zip, 10);
  const guests = parseInt(b.guests, 10);

  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Please enter a 10-digit phone number." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayChicago()) return res.status(400).json({ error: "Please choose a date." });
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Please choose a time." });
  if (!method) return res.status(400).json({ error: "Please choose delivery or pickup." });
  if (method !== "pickup") {
    if (!street) return res.status(400).json({ error: "Please enter the delivery address." });
    if (!city) return res.status(400).json({ error: "Please enter the city." });
    if (!/^\d{5}(-\d{4})?$/.test(zip)) return res.status(400).json({ error: "Please enter a 5-digit ZIP code." });
  }

  // What they picked, checked against the menu for that package. Every choice is required.
  let boxed = [], meats = [], sides = [], people = guests;
  if (pkg === "boxed") {
    const q = b.boxedQty || {};
    boxed = BOXED.map((item) => ({ item, qty: parseInt(q[item], 10) })).filter((x) => x.qty >= 1 && x.qty <= 2000);
    people = boxed.reduce((t, x) => t + x.qty, 0);
    if (!people || people > 2000) return res.status(400).json({ error: "Please enter how many of each boxed lunch you'd like." });
    sides = [...new Set(pick(b.sides, SIDES))];
    if (sides.length < 1 || sides.length > 2) return res.status(400).json({ error: "Please choose 1 or 2 sides for your boxed lunches." });
  } else {
    meats = [...new Set(pick(b.meats, ENTREES))];
    sides = [...new Set(pick(b.sides, SIDES))];
    if (pkg === "buffet" && !(guests >= 1 && guests <= 2000)) return res.status(400).json({ error: "Please enter how many people you're feeding." });
    if (pkg === "buffet" && (meats.length < 1 || meats.length > 2)) return res.status(400).json({ error: "Please choose 1 or 2 entrées." });
    if (sides.length !== 2) return res.status(400).json({ error: "Please choose 2 sides." });
  }

  const addons = [];
  for (const k of Object.keys(ADDONS)) {
    const q = parseInt((b.addons || {})[k], 10);
    if (q >= 1 && q <= 200) addons.push({ ...ADDONS[k], qty: q });
  }

  // Estimate before tax (boxed lunch uses the $15 starting price)
  const addonCents = addons.reduce((t, a) => t + a.qty * a.cents, 0);
  const est = people * PER_PERSON[pkg] + addonCents;

  const when = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const [hh, mm] = time.split(":").map(Number);
  const clock = ((hh % 12) || 12) + ":" + String(mm).padStart(2, "0") + (hh < 12 ? " AM" : " PM");

  const rows = [
    ["Name", name],
    ["Organization", org || "—"],
    ["Phone", phone],
    ["Email", email],
    ["Delivery or pickup", METHODS[method]],
    ...(method !== "pickup" ? [["Delivery address", `${street}, ${city} ${zip}`]] : []),
    [method === "pickup" ? "Pickup date & time" : "Delivery date & time", `${when} at ${clock}`],
    ["Restaurant", RESTAURANT],
    ["Package", PACKAGES[pkg]],
    ["Number of people", String(people)],
  ];
  if (pkg === "boxed") rows.push(["Boxed lunches", boxed.map((x) => `${x.qty} × ${x.item}`).join(", ")]);
  if (pkg === "boxed") rows.push(["Boxed lunch side" + (sides.length > 1 ? "s (split evenly)" : ""), sides.join(", ")]);
  if (pkg !== "boxed") rows.push(["Entrées", meats.join(", ")]);
  if (pkg !== "boxed") rows.push(["Sides", sides.join(", ")]);
  rows.push(["Add-ons", addons.map((a) => `${a.qty} × ${a.name} (${money(a.qty * a.cents)})`).join(", ") || "None"]);
  rows.push(["Estimate (before tax)", "From " + money(est) + (method === "far" ? " + delivery fee (not quoted yet)" : "")]);
  rows.push(["Notes", notes || "—"]);

  const subject = `Catering request: ${name}${org ? " (" + org + ")" : ""} · ${PACKAGES[pkg].split(" (")[0]} · ${when}`.slice(0, 200);
  const nextStep = (method === "far" ? "This delivery is more than 15 miles: check the distance and quote the delivery fee. " : "") + "Next step: confirm with the customer, then send a Square payment link or invoice (Square Dashboard → Payment links or Invoices). Reply to this email to reach the customer.";
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n\n" + nextStep;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;color:#1c1714">` +
    `<h2 style="margin:0 0 12px;color:#d9433b">New catering request</h2>` +
    `<table cellpadding="6" style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="font-weight:bold;vertical-align:top;white-space:nowrap">${esc(k)}</td><td>${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("") +
    `</table><p style="margin-top:16px;color:#6a5c53">${esc(nextStep)}</p></div>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + String(env.RESEND_API_KEY).trim(), "Content-Type": "application/json" },
      body: JSON.stringify({
        from: (env.CATERING_FROM || "").trim() || "Say McIntosh Catering <onboarding@resend.dev>",
        to: [env.CATERING_TO || "pies@mcintoshpies.com"],
        reply_to: email,
        subject,
        text,
        html,
      }),
    });
    if (!r.ok) {
      console.error("Resend error:", r.status, await r.text());
      return res.status(502).json({ error: "We couldn't send your request. Please try again, or email pies@mcintoshpies.com." });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Catering email failed:", e);
    return res.status(502).json({ error: "We couldn't send your request. Please try again, or email pies@mcintoshpies.com." });
  }
};
