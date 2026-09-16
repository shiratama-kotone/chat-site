const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const session = require("express-session");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const {
  CLOUDFLARE_ACCOUNT_ID,
  D1_DATABASE_ID,
  D1_API_TOKEN,
  ADMIN_NAME,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  NODE_ENV
} = process.env;

if (
  !CLOUDFLARE_ACCOUNT_ID ||
  !D1_DATABASE_ID ||
  !D1_API_TOKEN
) {
  console.error("D1 environment variables are missing");
  process.exit(1);
}

if (!ADMIN_NAME || !ADMIN_PASSWORD) {
  console.error("ADMIN_NAME or ADMIN_PASSWORD is missing");
  process.exit(1);
}

const D1_URL =
  `https://api.cloudflare.com/client/v4/accounts/` +
  `${CLOUDFLARE_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

async function d1Query(sql, params = []) {
  const response = await fetch(D1_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${D1_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      sql,
      params
    })
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    console.error("D1 error:", data);
    throw new Error("D1 query failed");
  }

  return data.result;
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

async function initializeDatabase() {
  await d1Query(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await d1Query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await d1Query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await d1Query(`
    INSERT OR IGNORE INTO settings (key, value)
    VALUES ('anonymous_mode', 'true')
  `);

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  await d1Query(
    `
      INSERT OR IGNORE INTO users (name)
      VALUES (?)
    `,
    [ADMIN_NAME]
  );

  console.log("Database initialized");
}

async function getAnonymousMode() {
  const result = await d1Query(
    `
      SELECT value
      FROM settings
      WHERE key = 'anonymous_mode'
      LIMIT 1
    `
  );

  if (
    !result[0] ||
    !result[0].results ||
    result[0].results.length === 0
  ) {
    return true;
  }

  return result[0].results[0].value === "true";
}

async function setAnonymousMode(enabled) {
  await d1Query(
    `
      INSERT INTO settings (key, value)
      VALUES ('anonymous_mode', ?)
      ON CONFLICT(key)
      DO UPDATE SET value = excluded.value
    `,
    [enabled ? "true" : "false"]
  );
}

async function getMessages() {
  const result = await d1Query(`
    SELECT
      messages.id,
      messages.content,
      messages.created_at,
      users.name AS user_name,
      messages.user_id
    FROM messages
    JOIN users
      ON users.id = messages.user_id
    ORDER BY messages.id ASC
  `);

  return result[0]?.results || [];
}

function publicMessages(messages, anonymousMode) {
  if (anonymousMode) {
    return messages.map(message => ({
      id: message.id,
      content: message.content,
      created_at: message.created_at
    }));
  }

  return messages.map(message => ({
    id: message.id,
    content: message.content,
    created_at: message.created_at,
    user_name: message.user_name
  }));
}

function adminMessages(messages) {
  return messages.map(message => ({
    id: message.id,
    content: message.content,
    created_at: message.created_at,
    user_id: message.user_id,
    user_name: message.user_name
  }));
}

async function getOrCreateUser(name) {
  await d1Query(
    `
      INSERT OR IGNORE INTO users (name)
      VALUES (?)
    `,
    [name]
  );

  const result = await d1Query(
    `
      SELECT id, name
      FROM users
      WHERE name = ?
      LIMIT 1
    `,
    [name]
  );

  return result[0]?.results?.[0] || null;
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

/* =========================
   Public API
========================= */

app.get("/api/settings", async (req, res) => {
  try {
    const anonymousMode = await getAnonymousMode();

    res.json({
      anonymous_mode: anonymousMode
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to get settings"
    });
  }
});

app.get("/api/messages", async (req, res) => {
  try {
    const anonymousMode = await getAnonymousMode();
    const messages = await getMessages();

    res.json(publicMessages(messages, anonymousMode));
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to get messages"
    });
  }
});

app.post("/api/messages", async (req, res) => {
  try {
    const content =
      typeof req.body.content === "string"
        ? req.body.content.trim()
        : "";

    const userName =
      typeof req.body.user_name === "string"
        ? req.body.user_name.trim()
        : "";

    if (!content) {
      return res.status(400).json({
        error: "Message is empty"
      });
    }

    if (!userName) {
      return res.status(400).json({
        error: "User name is required"
      });
    }

    const user = await getOrCreateUser(userName);

    if (!user) {
      return res.status(500).json({
        error: "Failed to create user"
      });
    }

    await d1Query(
      `
        INSERT INTO messages (user_id, content)
        VALUES (?, ?)
      `,
      [user.id, content]
    );

    const anonymousMode = await getAnonymousMode();
    const messages = await getMessages();

    const publicData = publicMessages(messages, anonymousMode);

    io.emit("messages_updated", publicData);

    res.json({
      success: true
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Failed to send message"
    });
  }
});

/* =========================
   Login
========================= */

app.post("/api/login", async (req, res) => {
  try {
    const name =
      typeof req.body.name === "string"
        ? req.body.name.trim()
        : "";

    const password =
      typeof req.body.password === "string"
        ? req.body.password
        : "";

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    const validName = name === ADMIN_NAME;
    const validPassword = await bcrypt.compare(
      password,
      passwordHash
    );

    if (!validName || !validPassword) {
      return res.status(403).send("認証成功");
    }

    req.session.isAdmin = true;
    req.session.adminName = ADMIN_NAME;

    req.session.save(error => {
      if (error) {
        console.error("Session save error:", error);

        return res.status(500).json({
          error: "Failed to save session"
        });
      }

      res.json({
        success: true
      });
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Login failed"
    });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(error => {
    if (error) {
      console.error(error);

      return res.status(500).json({
        error: "Logout failed"
      });
    }

    res.json({
      success: true
    });
  });
});

/* =========================
   Admin API
========================= */

app.get("/api/admin/messages", requireAdmin, async (req, res) => {
  try {
    const messages = await getMessages();

    res.json(adminMessages(messages));
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to get admin messages"
    });
  }
});

app.get("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const anonymousMode = await getAnonymousMode();

    res.json({
      anonymous_mode: anonymousMode
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to get admin settings"
    });
  }
});

app.post(
  "/api/admin/settings/anonymous",
  requireAdmin,
  async (req, res) => {
    try {
      const enabled = Boolean(req.body.enabled);

      await setAnonymousMode(enabled);

      const messages = await getMessages();
      const publicData = publicMessages(messages, enabled);

      io.emit("anonymous_mode_changed", {
        anonymous_mode: enabled
      });

      io.emit("messages_updated", publicData);

      res.json({
        success: true,
        anonymous_mode: enabled
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Failed to update anonymous mode"
      });
    }
  }
);

app.delete(
  "/api/admin/messages/:id",
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);

      if (!Number.isInteger(id)) {
        return res.status(400).json({
          error: "Invalid message ID"
        });
      }

      await d1Query(
        `
          DELETE FROM messages
          WHERE id = ?
        `,
        [id]
      );

      const anonymousMode = await getAnonymousMode();
      const messages = await getMessages();

      io.emit(
        "messages_updated",
        publicMessages(messages, anonymousMode)
      );

      res.json({
        success: true
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Failed to delete message"
      });
    }
  }
);

app.delete(
  "/api/admin/messages",
  requireAdmin,
  async (req, res) => {
    try {
      await d1Query(`
        DELETE FROM messages
      `);

      const anonymousMode = await getAnonymousMode();

      io.emit("messages_updated", []);

      res.json({
        success: true,
        anonymous_mode: anonymousMode
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: "Failed to delete all messages"
      });
    }
  }
);

/* =========================
   Admin page
========================= */

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

/* =========================
   Socket.IO
========================= */

io.on("connection", async socket => {
  try {
    const anonymousMode = await getAnonymousMode();
    const messages = await getMessages();

    socket.emit("anonymous_mode_changed", {
      anonymous_mode: anonymousMode
    });

    socket.emit(
      "messages_updated",
      publicMessages(messages, anonymousMode)
    );
  } catch (error) {
    console.error(error);
  }
});

/* =========================
   Start
========================= */

async function start() {
  try {
    await initializeDatabase();

    server.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();