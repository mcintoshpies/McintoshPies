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
const PER_PERSON = 1999; // cents: boxed lunch and buffet
const PLATTERS = { 25: 45000, 50: 87500, 75: 130000, 100: 170000 };
const ADDONS = {
  pie:      { name: "Whole Sweet Potato Pie", cents: 1999 },
  lemonade: { name: "Gallon of Lemonade",     cents: 1499 },
};
const PACKAGES = {
  boxed:   "Boxed Lunch ($19.99/person)",
  buffet:  "Lunch Buffet ($19.99/person)",
  platter: "Group Platter",
  dinner:  "Dinner (custom quote)",
};
const BOXED = ["Cheeseburger", "Turkey Burger", "Grilled Chicken Sandwich", "2-Piece Fried Catfish"];
const LUNCH_MEATS = ["Fried Catfish", "BBQ Pulled Chicken", "Sliced BBQ Beef", "BBQ Hot Links", "Grilled Chicken"];
const LUNCH_SIDES = ["Coleslaw", "Fried Okra", "Potato Salad"];
const DINNER_MEATS = ["Fried Catfish", "Fried Chicken", "Barbecue Chicken", "BBQ Pulled Chicken", "Sliced BBQ Beef", "BBQ Hot Links", "Grilled Chicken Breast", "Chicken & Dressing"];
const DINNER_SIDES = ["Greens", "Candied Yams", "Purple Hull Peas & Okra", "Green Beans", "Barbecue Beans", "Corn on the Cob", "Potato Salad", "Coleslaw"];
const LOCATIONS = { lr: "Little Rock · 6223 Colonel Glenn Rd", nlr: "North Little Rock · 4604 E Broadway St" };
const EVENTS = { family: "Family gathering", office: "Office / work", church: "Church group", other: "Other event" };

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
  const loc = LOCATIONS[b.location] ? b.location : "";
  const event = EVENTS[b.event] ? b.event : "";
  const guests = parseInt(b.guests, 10);
  const platter = PLATTERS[b.platter] ? Number(b.platter) : 0;

  if (!name) return res.status(400).json({ error: "Please enter your name." });
  if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Please enter a 10-digit phone number." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayChicago()) return res.status(400).json({ error: "Please choose a date for your event." });
  if (!/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: "Please choose a time." });
  if (!loc) return res.status(400).json({ error: "Please choose which restaurant you'll order from." });
  if (pkg === "platter" && !platter) return res.status(400).json({ error: "Please choose a platter size." });
  if (pkg !== "platter" && !(guests >= 1 && guests <= 2000)) return res.status(400).json({ error: "Please enter how many people you're feeding." });

  // What they picked, checked against the menu for that package
  let boxed = [], meats = [], sides = [];
  if (pkg === "boxed") boxed = pick(b.boxed, BOXED);
  if (pkg === "buffet" || pkg === "platter") { meats = pick(b.meats, LUNCH_MEATS).slice(0, 2); sides = pick(b.sides, LUNCH_SIDES).slice(0, 2); }
  if (pkg === "dinner") { meats = pick(b.meats, DINNER_MEATS); sides = pick(b.sides, DINNER_SIDES); }

  const addons = [];
  for (const k of Object.keys(ADDONS)) {
    const q = parseInt((b.addons || {})[k], 10);
    if (q >= 1 && q <= 200) addons.push({ ...ADDONS[k], qty: q });
  }

  // Estimate before tax (dinner is quoted by staff)
  let est = null;
  if (pkg === "boxed" || pkg === "buffet") est = guests * PER_PERSON;
  if (pkg === "platter") est = PLATTERS[platter];
  const addonCents = addons.reduce((t, a) => t + a.qty * a.cents, 0);
  if (est != null) est += addonCents;

  const when = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const [hh, mm] = time.split(":").map(Number);
  const clock = ((hh % 12) || 12) + ":" + String(mm).padStart(2, "0") + (hh < 12 ? " AM" : " PM");

  const rows = [
    ["Name", name],
    ["Organization", org || "—"],
    ["Phone", phone],
    ["Email", email],
    ["Event", event ? EVENTS[event] : "—"],
    ["Date & time", `${when} at ${clock}`],
    ["Restaurant", LOCATIONS[loc]],
    ["Package", PACKAGES[pkg]],
    pkg === "platter" ? ["Platter size", `Feeds ${platter} (${money(PLATTERS[platter])})`] : ["Number of people", String(guests)],
  ];
  if (pkg === "boxed") rows.push(["Boxed lunch picks", boxed.join(", ") || "Not chosen yet"]);
  if (pkg !== "boxed") rows.push([pkg === "dinner" ? "Entrées" : "Meats", meats.join(", ") || "Not chosen yet"]);
  if (pkg !== "boxed") rows.push(["Sides", sides.join(", ") || "Not chosen yet"]);
  rows.push(["Add-ons", addons.map((a) => `${a.qty} × ${a.name} (${money(a.qty * a.cents)})`).join(", ") || "None"]);
  rows.push(["Estimate (before tax)", est != null ? money(est) : `Custom quote needed${addonCents ? " (add-ons " + money(addonCents) + ")" : ""}`]);
  rows.push(["Notes", notes || "—"]);

  const subject = `Catering request: ${name}${org ? " (" + org + ")" : ""} · ${PACKAGES[pkg].split(" (")[0]} · ${when}`.slice(0, 200);
  const nextStep = "Next step: confirm with the customer, then send a Square payment link or invoice (Square Dashboard → Payment links or Invoices). Reply to this email to reach the customer.";
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
