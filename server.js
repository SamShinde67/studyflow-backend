const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Init database
const db = new Database(path.join("/tmp", "studyflow.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    uses INTEGER DEFAULT 0,
    is_pro INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Register email / get usage
app.post("/register", (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Invalid email" });
  }
  const lower = email.toLowerCase().trim();
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(lower);
  if (existing) {
    return res.json({ uses: existing.uses, is_pro: existing.is_pro });
  }
  db.prepare("INSERT INTO users (email) VALUES (?)").run(lower);
  return res.json({ uses: 0, is_pro: 0 });
});

// Generate endpoint — checks usage before calling API
app.post("/generate", async (req, res) => {
  const { prompt, email } = req.body;

  if (!prompt) return res.status(400).json({ error: "No prompt provided" });
  if (!email) return res.status(400).json({ error: "No email provided" });

  const lower = email.toLowerCase().trim();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(lower);

  if (!user) return res.status(403).json({ error: "Email not registered" });

  const FREE_LIMIT = 2;
  if (!user.is_pro && user.uses >= FREE_LIMIT) {
    return res.status(403).json({ error: "free_limit_reached" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1400,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();

    // Increment usage after successful generation
    db.prepare("UPDATE users SET uses = uses + 1 WHERE email = ?").run(lower);

    res.json({ ...data, uses: user.uses + 1, is_pro: user.is_pro });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Unlock pro via code
app.post("/unlock", (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Missing fields" });
  if (code.toUpperCase() !== "SFPRO2026") {
    return res.status(403).json({ error: "invalid_code" });
  }
  const lower = email.toLowerCase().trim();
  db.prepare("UPDATE users SET is_pro = 1 WHERE email = ?").run(lower);
  res.json({ success: true });
});

app.get("/", (req, res) => res.send("StudyFlow API is running."));

// Admin dashboard — password protected
app.get("/admin", (req, res) => {
  const { password } = req.query;
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).send("Unauthorized");
  }
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  const totalUsers = users.length;
  const proUsers = users.filter(u => u.is_pro).length;
  const freeUsers = totalUsers - proUsers;
  const rows = users.map(u => `
    <tr style="border-bottom:1px solid #eee;">
      <td style="padding:10px 16px;">${u.email}</td>
      <td style="padding:10px 16px;text-align:center;">${u.uses}</td>
      <td style="padding:10px 16px;text-align:center;">
        <span style="padding:3px 10px;border-radius:100px;font-size:12px;font-weight:600;${u.is_pro ? 'background:#e8f4ee;color:#2d6a4f;' : 'background:#f5e8e4;color:#c84b2f;'}">
          ${u.is_pro ? 'Pro' : 'Free'}
        </span>
      </td>
      <td style="padding:10px 16px;color:#8c867d;font-size:13px;">${u.created_at}</td>
    </tr>`).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>StudyFlow Admin</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; background: #f7f4ee; margin: 0; padding: 2rem; }
        h1 { font-size: 24px; margin-bottom: 4px; }
        .subtitle { color: #8c867d; font-size: 14px; margin-bottom: 2rem; }
        .stats { display: flex; gap: 16px; margin-bottom: 2rem; flex-wrap: wrap; }
        .stat { background: #fff; border: 1px solid #e0ddd6; border-radius: 12px; padding: 1rem 1.5rem; min-width: 120px; }
        .stat-num { font-size: 28px; font-weight: 600; }
        .stat-label { font-size: 12px; color: #8c867d; text-transform: uppercase; letter-spacing: 0.06em; }
        table { width: 100%; background: #fff; border-radius: 12px; border-collapse: collapse; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        th { text-align: left; padding: 12px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #8c867d; border-bottom: 2px solid #eee; }
        tr:hover { background: #fafaf8; }
      </style>
    </head>
    <body>
      <h1>&#x2022; StudyFlow Admin</h1>
      <p class="subtitle">User dashboard</p>
      <div class="stats">
        <div class="stat"><div class="stat-num">${totalUsers}</div><div class="stat-label">Total users</div></div>
        <div class="stat"><div class="stat-num" style="color:#2d6a4f;">${proUsers}</div><div class="stat-label">Pro users</div></div>
        <div class="stat"><div class="stat-num" style="color:#c84b2f;">${freeUsers}</div><div class="stat-label">Free users</div></div>
        <div class="stat"><div class="stat-num" style="color:#1e4d8c;">$${proUsers * 9}</div><div class="stat-label">Est. MRR</div></div>
      </div>
      <table>
        <thead><tr><th>Email</th><th style="text-align:center;">Uses</th><th style="text-align:center;">Plan</th><th>Signed up</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="padding:2rem;text-align:center;color:#8c867d;">No users yet</td></tr>'}</tbody>
      </table>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
