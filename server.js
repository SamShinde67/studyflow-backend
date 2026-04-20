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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
