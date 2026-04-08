// Delt Marketing Site — lightweight deploy server
// Serves landing page + handles signups (email + Google Sheets)

const express = require("express");
const path = require("path");
const fs = require("fs");
const nodemailer = require("nodemailer");

require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Security headers
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

// CORS for signup endpoint
app.use("/api/signup", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Rate limiter
const rateBuckets = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const bucket = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + windowMs; }
    bucket.count++;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ error: "Too many requests" });
    next();
  };
}

// Clean stale rate-limit entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) { if (now > v.reset) rateBuckets.delete(k); }
}, 300000);

// Static files
app.use("/public", express.static(path.join(__dirname, "public")));

// Version check — clients poll this to auto-update
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
app.get("/api/version", (req, res) => {
  res.json({ version: pkg.version, download: "/public/delt-latest.tar.gz" });
});

// Routes
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "explainer.html")));
app.get("/install", (req, res) => res.sendFile(path.join(__dirname, "install.html")));
app.get("/installer", (req, res) => res.sendFile(path.join(__dirname, "delt-installer.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));
app.get("/showcase", (req, res) => res.sendFile(path.join(__dirname, "public", "showcase.html")));
// OAuth relay — Google redirects here, we bounce the code to the user's localhost
app.get("/oauth/callback", (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Authorization failed</h2><p>${error}</p></body></html>`);
  }
  // State format: "uuid:port"
  const parts = (state || "").split(":");
  const port = parts[1];
  if (!port || isNaN(port)) {
    return res.status(400).send(`<html><body style="font-family:system-ui;text-align:center;padding:60px"><h2>Invalid callback</h2><p>Missing port in state parameter.</p></body></html>`);
  }
  // Redirect to user's local Delt instance
  const localUrl = `http://localhost:${port}/oauth/callback?${new URLSearchParams({ code, state }).toString()}`;
  res.redirect(localUrl);
});

app.get("/install.sh", (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.sendFile(path.join(__dirname, "install.sh"));
});
app.get("/uninstall.sh", (req, res) => {
  res.set("Content-Type", "text/plain; charset=utf-8");
  res.sendFile(path.join(__dirname, "uninstall.sh"));
});

// Health check
app.get("/health", (req, res) => res.json({ ok: true, version: "2.0.0" }));

// Mail transporter
function getMailTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

// Google Sheets append
async function appendToSheet(sheetId, range, values) {
  try {
    const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!keyFile || !fs.existsSync(keyFile)) return false;
    const sa = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    const jwt = await getGoogleJWT(sa);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    });
    return r.ok;
  } catch { return false; }
}

async function getGoogleJWT(sa) {
  const crypto = require("crypto");
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })).toString("base64url");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), sa.private_key);
  const assertion = `${header}.${payload}.${sig.toString("base64url")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${assertion}`,
  });
  const data = await r.json();
  return data.access_token;
}

// Escape HTML to prevent injection in email bodies
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateVCard(name, email) {
  return `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nEMAIL:${email}\nNOTE:Delt early access signup — ${new Date().toISOString().split("T")[0]}\nEND:VCARD`;
}

function logSignupLocally(entry) {
  const file = path.join(__dirname, "signups.json");
  let signups = [];
  try { signups = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  signups.push(entry);
  fs.writeFileSync(file, JSON.stringify(signups, null, 2));
}

// Global daily email cap — hard ceiling prevents relay abuse regardless of IP rotation
const DAILY_EMAIL_CAP = 100;
let dailyEmailCount = 0;
let dailyEmailResetDate = new Date().toISOString().slice(0, 10);
function checkDailyEmailCap() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyEmailResetDate) {
    dailyEmailCount = 0;
    dailyEmailResetDate = today;
  }
  return dailyEmailCount < DAILY_EMAIL_CAP;
}

// Signup endpoint
app.post("/api/signup", rateLimit(60000, 5), async (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Valid email required" });

  // Validate email format strictly — prevent use as open email relay
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!emailRegex.test(email) || email.length > 254) {
    return res.status(400).json({ error: "Invalid email format" });
  }

  // Sanitize name — strip control chars/newlines, limit length
  const rawName = (name || email.split("@")[0]).replace(/[\r\n\t]/g, " ").trim().slice(0, 100);
  const displayName = escapeHtml(rawName);
  const timestamp = new Date().toISOString();
  const results = { email: true, notification: false, sheet: false };

  logSignupLocally({ email, name: rawName, timestamp });

  const transporter = getMailTransporter();
  if (transporter && checkDailyEmailCap()) {
    dailyEmailCount++;
    try {
      await transporter.sendMail({
        from: `"Neonotics" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: "Welcome to Delt \u2014 You're on the list",
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:40px 24px;color:#18182B"><div style="text-align:center;margin-bottom:32px"><div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:12px;background:linear-gradient(135deg,#6C5CE7,#06B6D4);color:#fff;font-weight:800;font-size:20px">D</div></div><h1 style="font-size:24px;font-weight:700;margin-bottom:16px;text-align:center">Thank you for your interest in Delt</h1><p style="font-size:15px;line-height:1.7;color:#5C5C72;margin-bottom:20px">Hey ${displayName},</p><p style="font-size:15px;line-height:1.7;color:#5C5C72;margin-bottom:20px">You're on the early access list for Delt \u2014 the AI assistant that connects to your tools and actually does things. Gmail, Slack, GitHub, Notion, Stripe, and more, all through one conversation.</p><p style="font-size:15px;line-height:1.7;color:#5C5C72;margin-bottom:20px">We're letting people in weekly. When it's your turn, you'll get an invite with everything you need to get started.</p><p style="font-size:15px;line-height:1.7;color:#5C5C72;margin-bottom:32px">In the meantime \u2014 if you have questions, just reply to this email. A real person reads it.</p><div style="border-top:1px solid #E3E3E8;padding-top:20px;text-align:center"><p style="font-size:13px;color:#9494A8;margin:0">Delt by <a href="mailto:neonotics@gmail.com" style="color:#6C5CE7;text-decoration:none">Neonotics</a></p></div></div>`,
      });
    } catch (e) { console.error("Thank-you email failed:", e.message); results.email = false; }

    try {
      await transporter.sendMail({
        from: `"Delt Signups" <${process.env.GMAIL_USER}>`,
        to: process.env.GMAIL_USER,
        subject: `Delt \u2014 New signup: ${rawName}`,
        html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;padding:32px 24px;color:#18182B"><h1 style="font-size:22px;font-weight:700;margin-bottom:20px">Delt</h1><div style="background:#F7F7F8;border-radius:12px;padding:20px;margin-bottom:20px;border:1px solid #E3E3E8"><p style="margin:0 0 8px;font-size:18px;font-weight:600">${displayName}</p><p style="margin:0 0 4px;font-size:14px;color:#5C5C72"><a href="mailto:${escapeHtml(email)}" style="color:#6C5CE7;text-decoration:none">${escapeHtml(email)}</a></p><p style="margin:8px 0 0;font-size:12px;color:#9494A8">Signed up: ${new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}</p></div></div>`,
        attachments: [{ filename: `${rawName.replace(/[^a-zA-Z0-9]/g, "_")}.vcf`, content: generateVCard(rawName, email), contentType: "text/vcard" }],
      });
      results.notification = true;
    } catch (e) { console.error("Notification email failed:", e.message); }
  } else if (!transporter) {
    console.warn("GMAIL credentials not set — emails skipped.");
  } else {
    console.warn(`Daily email cap (${DAILY_EMAIL_CAP}) reached — emails skipped.`);
  }

  try {
    const sheetId = process.env.GOOGLE_SHEETS_ID;
    if (sheetId) results.sheet = await appendToSheet(sheetId, "Sheet1!A:D", [[timestamp, rawName, email, "early-access"]]);
  } catch (e) { console.error("Sheets append failed:", e.message); }

  console.log(`[signup] ${rawName} <${email}> — email:${results.email} notify:${results.notification} sheet:${results.sheet}`);
  res.json({ ok: true, results });
});

// 404
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "demo.html")));

// Local dev / Fly.io — listen directly
if (!process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Delt marketing site live on port ${PORT}`));
}

// Vercel serverless — export the Express app
module.exports = app;
