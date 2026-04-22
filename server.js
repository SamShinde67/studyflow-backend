const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const db = new Database(path.join("/tmp", "studyflow.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    uses INTEGER DEFAULT 0,
    is_pro INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS groups (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    creator_email TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_code TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    guides INTEGER DEFAULT 0,
    quizzes INTEGER DEFAULT 0,
    mins INTEGER DEFAULT 0,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_code, email)
  );
  CREATE TABLE IF NOT EXISTS group_guides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_code TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    title TEXT,
    guide_data TEXT NOT NULL,
    shared_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guide_id TEXT NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    comment TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── USER ENDPOINTS ──
app.post("/register", (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Invalid email" });
  const lower = email.toLowerCase().trim();
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(lower);
  if (existing) return res.json({ uses: existing.uses, is_pro: existing.is_pro });
  db.prepare("INSERT INTO users (email) VALUES (?)").run(lower);
  return res.json({ uses: 0, is_pro: 0 });
});

app.post("/generate", async (req, res) => {
  const { prompt, email } = req.body;
  if (!prompt) return res.status(400).json({ error: "No prompt provided" });
  if (!email) return res.status(400).json({ error: "No email provided" });
  const lower = email.toLowerCase().trim();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(lower);
  if (!user) return res.status(403).json({ error: "Email not registered" });
  const FREE_LIMIT = 2;
  if (!user.is_pro && user.uses >= FREE_LIMIT) return res.status(403).json({ error: "free_limit_reached" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 1400, messages: [{ role: "user", content: prompt }] })
    });
    const data = await response.json();
    db.prepare("UPDATE users SET uses = uses + 1 WHERE email = ?").run(lower);
    res.json({ ...data, uses: user.uses + 1, is_pro: user.is_pro });
  } catch (err) {
    res.status(500).json({ error: "Something went wrong" });
  }
});

app.post("/unlock", (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Missing fields" });
  if (code.toUpperCase() !== "SFPRO2026") return res.status(403).json({ error: "invalid_code" });
  const lower = email.toLowerCase().trim();
  db.prepare("UPDATE users SET is_pro = 1 WHERE email = ?").run(lower);
  res.json({ success: true });
});

// ── GROUP ENDPOINTS ──

// Create a group
app.post("/groups/create", (req, res) => {
  const { email, name, displayName } = req.body;
  if (!email || !name) return res.status(400).json({ error: "Missing fields" });
  const lower = email.toLowerCase().trim();
  // Generate unique 6-char code
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (db.prepare("SELECT code FROM groups WHERE code = ?").get(code));
  db.prepare("INSERT INTO groups (code, name, creator_email) VALUES (?, ?, ?)").run(code, name, lower);
  db.prepare("INSERT OR IGNORE INTO group_members (group_code, email, display_name) VALUES (?, ?, ?)").run(code, lower, displayName || email.split('@')[0]);
  res.json({ code, name });
});

// Join a group
app.post("/groups/join", (req, res) => {
  const { email, code, displayName } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Missing fields" });
  const lower = email.toLowerCase().trim();
  const upper = code.toUpperCase().trim();
  const group = db.prepare("SELECT * FROM groups WHERE code = ?").get(upper);
  if (!group) return res.status(404).json({ error: "group_not_found" });
  db.prepare("INSERT OR IGNORE INTO group_members (group_code, email, display_name) VALUES (?, ?, ?)").run(upper, lower, displayName || email.split('@')[0]);
  res.json({ code: upper, name: group.name });
});

// Get group info + members (leaderboard)
app.get("/groups/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  const group = db.prepare("SELECT * FROM groups WHERE code = ?").get(code);
  if (!group) return res.status(404).json({ error: "group_not_found" });
  const members = db.prepare("SELECT * FROM group_members WHERE group_code = ? ORDER BY guides DESC, quizzes DESC").all(code);
  const guides = db.prepare("SELECT * FROM group_guides WHERE group_code = ? ORDER BY shared_at DESC LIMIT 20").all(code);
  res.json({ group, members, guides });
});

// Share a guide to a group
app.post("/groups/share", (req, res) => {
  const { email, code, title, guideData, displayName } = req.body;
  if (!email || !code || !guideData) return res.status(400).json({ error: "Missing fields" });
  const lower = email.toLowerCase().trim();
  const upper = code.toUpperCase().trim();
  const member = db.prepare("SELECT * FROM group_members WHERE group_code = ? AND email = ?").get(upper, lower);
  if (!member) return res.status(403).json({ error: "Not a member of this group" });
  const result = db.prepare("INSERT INTO group_guides (group_code, email, display_name, title, guide_data) VALUES (?, ?, ?, ?, ?)").run(upper, lower, displayName || email.split('@')[0], title || "Study Guide", JSON.stringify(guideData));
  res.json({ success: true, id: result.lastInsertRowid });
});

// Update member stats
app.post("/groups/stats", (req, res) => {
  const { email, code, guides, quizzes, mins } = req.body;
  if (!email || !code) return res.status(400).json({ error: "Missing fields" });
  const lower = email.toLowerCase().trim();
  const upper = code.toUpperCase().trim();
  if (guides) db.prepare("UPDATE group_members SET guides = guides + ? WHERE group_code = ? AND email = ?").run(guides, upper, lower);
  if (quizzes) db.prepare("UPDATE group_members SET quizzes = quizzes + ? WHERE group_code = ? AND email = ?").run(quizzes, upper, lower);
  if (mins) db.prepare("UPDATE group_members SET mins = mins + ? WHERE group_code = ? AND email = ?").run(mins, upper, lower);
  res.json({ success: true });
});

// ── COMMENT ENDPOINTS ──
app.get("/comments/:guideId", (req, res) => {
  const comments = db.prepare("SELECT * FROM comments WHERE guide_id = ? ORDER BY created_at ASC").all(req.params.guideId);
  res.json({ comments });
});

app.post("/comments", (req, res) => {
  const { guideId, email, comment, displayName } = req.body;
  if (!guideId || !email || !comment) return res.status(400).json({ error: "Missing fields" });
  if (comment.length > 500) return res.status(400).json({ error: "Comment too long" });
  const lower = email.toLowerCase().trim();
  db.prepare("INSERT INTO comments (guide_id, email, display_name, comment) VALUES (?, ?, ?, ?)").run(guideId, lower, displayName || email.split('@')[0], comment.trim());
  const comments = db.prepare("SELECT * FROM comments WHERE guide_id = ? ORDER BY created_at ASC").all(guideId);
  res.json({ comments });
});

// ── ADMIN ──
app.get("/admin", (req, res) => {
  if (req.query.password !== process.env.ADMIN_PASSWORD) return res.status(401).send("Unauthorized");
  const users = db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
  const groups = db.prepare("SELECT * FROM groups ORDER BY created_at DESC").all();
  const totalUsers = users.length, proUsers = users.filter(u => u.is_pro).length;
  const rows = users.map(u => `<tr><td style="padding:8px 14px;">${u.email}</td><td style="padding:8px 14px;text-align:center;">${u.uses}</td><td style="padding:8px 14px;text-align:center;"><span style="padding:2px 8px;border-radius:100px;font-size:11px;font-weight:600;${u.is_pro?'background:#e8f4ee;color:#2d6a4f;':'background:#f5e8e4;color:#c84b2f;'}">${u.is_pro?'Pro':'Free'}</span></td><td style="padding:8px 14px;font-size:12px;color:#8C867D;">${u.created_at}</td></tr>`).join('');
  const groupRows = groups.map(g => `<tr><td style="padding:8px 14px;font-weight:600;">${g.code}</td><td style="padding:8px 14px;">${g.name}</td><td style="padding:8px 14px;font-size:12px;color:#8C867D;">${g.creator_email}</td></tr>`).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>StudyFlow Admin</title><style>body{font-family:sans-serif;background:#f7f4ee;padding:2rem;max-width:900px;margin:0 auto;}h1{font-size:22px;margin-bottom:4px;}.stats{display:flex;gap:14px;margin:1.5rem 0;flex-wrap:wrap;}.stat{background:#fff;border:1px solid #e0ddd6;border-radius:12px;padding:1rem 1.5rem;}.stat-n{font-size:28px;font-weight:600;}.stat-l{font-size:11px;color:#8C867D;text-transform:uppercase;letter-spacing:0.06em;}table{width:100%;background:#fff;border-radius:12px;border-collapse:collapse;box-shadow:0 2px 8px rgba(0,0,0,0.06);margin-bottom:2rem;}th{text-align:left;padding:10px 14px;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#8C867D;border-bottom:2px solid #eee;}tr:hover{background:#fafaf8;}</style></head><body>
  <h1>● StudyFlow Admin</h1>
  <div class="stats">
    <div class="stat"><div class="stat-n">${totalUsers}</div><div class="stat-l">Total users</div></div>
    <div class="stat"><div class="stat-n" style="color:#2d6a4f;">${proUsers}</div><div class="stat-l">Pro users</div></div>
    <div class="stat"><div class="stat-n" style="color:#c84b2f;">${totalUsers-proUsers}</div><div class="stat-l">Free users</div></div>
    <div class="stat"><div class="stat-n" style="color:#1e4d8c;">$${proUsers*9}</div><div class="stat-l">Est. MRR</div></div>
    <div class="stat"><div class="stat-n">${groups.length}</div><div class="stat-l">Class groups</div></div>
  </div>
  <h2 style="font-size:16px;margin-bottom:12px;">Users</h2>
  <table><thead><tr><th>Email</th><th>Uses</th><th>Plan</th><th>Signed up</th></tr></thead><tbody>${rows||'<tr><td colspan="4" style="padding:2rem;text-align:center;color:#8C867D;">No users yet</td></tr>'}</tbody></table>
  <h2 style="font-size:16px;margin-bottom:12px;">Class Groups</h2>
  <table><thead><tr><th>Code</th><th>Name</th><th>Creator</th></tr></thead><tbody>${groupRows||'<tr><td colspan="3" style="padding:2rem;text-align:center;color:#8C867D;">No groups yet</td></tr>'}</tbody></table>
  </body></html>`);
});

app.get("/", (req, res) => res.send("StudyFlow API is running."));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
