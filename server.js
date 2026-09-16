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

const PORT = process.env.PORT || 3000;

const D1_API_URL =
  `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${process.env.D1_DATABASE_ID}/query`;

const D1_API_TOKEN = process.env.D1_API_TOKEN;

if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.error("CLOUDFLARE_ACCOUNT_ID が設定されていません");
  process.exit(1);
}

if (!process.env.D1_DATABASE_ID) {
  console.error("D1_DATABASE_ID が設定されていません");
  process.exit(1);
}

if (!D1_API_TOKEN) {
  console.error("D1_API_TOKEN が設定されていません");
  process.exit(1);
}

if (!process.env.ADMIN_NAME) {
  console.error("ADMIN_NAME が設定されていません");
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.error("ADMIN_PASSWORD が設定されていません");
  process.exit(1);
}

const sessionMiddleware = session({
  secret:
    process.env.SESSION_SECRET ||
    crypto.randomBytes(32).toString("hex"),

  resave: false,
  saveUninitialized: false,

  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, "public")));


/* =========================
   Cloudflare D1
========================= */

async function d1Query(sql, params = []) {
  const response = await fetch(D1_API_URL, {
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
    console.error("D1 API Error:", data);

    throw new Error(
      data.errors?.[0]?.message ||
      "D1 API request failed"
    );
  }

  return data.result?.[0];
}


/* =========================
   初期化
========================= */

async function initializeDatabase() {
  await d1Query(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await d1Query(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (user_id)
        REFERENCES users(id)
        ON DELETE CASCADE
    )
  `);

  await d1Query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await d1Query(`
    INSERT OR IGNORE INTO settings
      (key, value)
    VALUES
      ('anonymous_mode', 'true')
  `);

  await d1Query(
    `
    INSERT OR IGNORE INTO users
      (name)
    VALUES
      (?)
    `,
    [process.env.ADMIN_NAME]
  );

  console.log("D1初期化完了");
}


/* =========================
   設定
========================= */

async function getAnonymousMode() {
  const result = await d1Query(`
    SELECT value
    FROM settings
    WHERE key = 'anonymous_mode'
    LIMIT 1
  `);

  if (!result.results.length) {
    return true;
  }

  return result.results[0].value === "true";
}


async function setAnonymousMode(enabled) {
  await d1Query(
    `
    INSERT INTO settings
      (key, value)
    VALUES
      ('anonymous_mode', ?)

    ON CONFLICT(key)
    DO UPDATE SET
      value = excluded.value
    `,
    [enabled ? "true" : "false"]
  );
}


/* =========================
   メッセージ
========================= */

async function getMessages() {
  const result = await d1Query(`
    SELECT
      messages.id,
      messages.content,
      messages.created_at,
      users.id AS user_id,
      users.name AS user_name

    FROM messages

    INNER JOIN users
      ON users.id = messages.user_id

    ORDER BY messages.id ASC
  `);

  return result.results || [];
}


function publicMessages(messages, anonymousMode) {
  if (anonymousMode) {
    /*
     * 匿名モードでは
     * user_nameを絶対に返さない。
     */

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


/* =========================
   ユーザー
========================= */

async function getOrCreateUser(name) {
  await d1Query(
    `
    INSERT OR IGNORE INTO users
      (name)
    VALUES
      (?)
    `,
    [name]
  );

  const result = await d1Query(
    `
    SELECT
      id,
      name
    FROM users
    WHERE name = ?
    LIMIT 1
    `,
    [name]
  );

  return result.results[0];
}


/* =========================
   管理者認証
========================= */

function requireAdmin(req, res, next) {
  if (!req.session.adminAuthenticated) {
    return res.status(401).json({
      authenticated: false
    });
  }

  next();
}


/* =========================
   一般API
========================= */

app.get("/api/settings", async (req, res) => {
  try {
    const anonymousMode =
      await getAnonymousMode();

    res.json({
      anonymous_mode: anonymousMode
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "設定の取得に失敗しました"
    });
  }
});


app.get("/api/messages", async (req, res) => {
  try {
    const anonymousMode =
      await getAnonymousMode();

    const messages =
      await getMessages();

    res.json({
      anonymous_mode: anonymousMode,

      /*
       * 匿名ONなら名前はレスポンスに存在しない。
       */
      messages: publicMessages(
        messages,
        anonymousMode
      )
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "メッセージの取得に失敗しました"
    });
  }
});


app.post("/api/messages", async (req, res) => {
  try {
    const name =
      String(req.body.name || "").trim();

    const content =
      String(req.body.content || "").trim();

    if (!name || !content) {
      return res.status(400).json({
        error:
          "名前とメッセージを入力してください"
      });
    }

    if (name.length > 50) {
      return res.status(400).json({
        error: "名前が長すぎます"
      });
    }

    if (content.length > 2000) {
      return res.status(400).json({
        error:
          "メッセージが長すぎます"
      });
    }

    const user =
      await getOrCreateUser(name);

    await d1Query(
      `
      INSERT INTO messages
        (user_id, content)
      VALUES
        (?, ?)
      `,
      [
        user.id,
        content
      ]
    );

    const anonymousMode =
      await getAnonymousMode();

    const messages =
      await getMessages();

    /*
     * 匿名ON:
     * 名前を送信しない。
     *
     * 匿名OFF:
     * 名前を送信する。
     */
    io.emit(
      "messages_updated",
      {
        anonymous_mode: anonymousMode,

        messages: publicMessages(
          messages,
          anonymousMode
        )
      }
    );

    res.json({
      success: true
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        "メッセージの送信に失敗しました"
    });
  }
});


/* =========================
   ログイン
========================= */

app.post("/api/login", async (req, res) => {
  try {
    const name =
      String(req.body.name || "");

    const password =
      String(req.body.password || "");

    const nameCorrect =
      name === process.env.ADMIN_NAME;

    /*
     * 管理者パスワードは環境変数に保存。
     * DBには保存しない。
     */

    const passwordHash =
      await bcrypt.hash(
        process.env.ADMIN_PASSWORD,
        12
      );

    const passwordCorrect =
      await bcrypt.compare(
        password,
        passwordHash
      );

    if (!nameCorrect || !passwordCorrect) {
      /*
       * 指定仕様:
       *
       * HTTP 403
       * 本文「認証成功」
       */

      return res
        .status(403)
        .send("認証成功");
    }

    req.session.adminAuthenticated = true;

    res.json({
      authenticated: true
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "認証処理に失敗しました"
    });
  }
});


/* =========================
   ログアウト
========================= */

app.post(
  "/api/logout",
  requireAdmin,
  (req, res) => {

    req.session.destroy(() => {
      res.json({
        authenticated: false
      });
    });
  }
);


/* =========================
   管理API
========================= */

app.get(
  "/api/admin/messages",
  requireAdmin,
  async (req, res) => {

    try {
      const messages =
        await getMessages();

      res.json({
        messages:
          adminMessages(messages)
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "メッセージの取得に失敗しました"
      });
    }
  }
);


app.get(
  "/api/admin/settings",
  requireAdmin,
  async (req, res) => {

    try {
      const anonymousMode =
        await getAnonymousMode();

      res.json({
        anonymous_mode:
          anonymousMode
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "設定の取得に失敗しました"
      });
    }
  }
);


/* =========================
   匿名モード切り替え
========================= */

app.post(
  "/api/admin/settings/anonymous",
  requireAdmin,
  async (req, res) => {

    try {
      const enabled =
        Boolean(req.body.enabled);

      await setAnonymousMode(
        enabled
      );

      /*
       * 全員へモード変更を通知。
       */
      io.emit(
        "anonymous_mode_changed",
        {
          anonymous_mode: enabled
        }
      );

      /*
       * 過去ログも全部再送信。
       *
       * ON:
       *   名前なし
       *
       * OFF:
       *   名前あり
       */
      const messages =
        await getMessages();

      io.emit(
        "messages_updated",
        {
          anonymous_mode: enabled,

          messages: publicMessages(
            messages,
            enabled
          )
        }
      );

      res.json({
        anonymous_mode:
          enabled
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "設定変更に失敗しました"
      });
    }
  }
);


/* =========================
   メッセージ削除
========================= */

app.delete(
  "/api/admin/messages/:id",
  requireAdmin,
  async (req, res) => {

    try {
      await d1Query(
        `
        DELETE FROM messages
        WHERE id = ?
        `,
        [req.params.id]
      );

      const anonymousMode =
        await getAnonymousMode();

      const messages =
        await getMessages();

      io.emit(
        "messages_updated",
        {
          anonymous_mode:
            anonymousMode,

          messages: publicMessages(
            messages,
            anonymousMode
          )
        }
      );

      res.json({
        success: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "メッセージの削除に失敗しました"
      });
    }
  }
);


/* =========================
   全削除
========================= */

app.delete(
  "/api/admin/messages",
  requireAdmin,
  async (req, res) => {

    try {
      await d1Query(`
        DELETE FROM messages
      `);

      const anonymousMode =
        await getAnonymousMode();

      io.emit(
        "messages_updated",
        {
          anonymous_mode:
            anonymousMode,

          messages: []
        }
      );

      res.json({
        success: true
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "メッセージの削除に失敗しました"
      });
    }
  }
);


/* =========================
   Socket.IO
========================= */

io.use((socket, next) => {
  sessionMiddleware(
    socket.request,
    {},
    next
  );
});


io.on("connection", async socket => {
  try {
    const anonymousMode =
      await getAnonymousMode();

    const messages =
      await getMessages();

    /*
     * 初期接続時も匿名ONなら
     * 名前を一切送らない。
     */
    socket.emit(
      "initial_data",
      {
        anonymous_mode:
          anonymousMode,

        messages: publicMessages(
          messages,
          anonymousMode
        )
      }
    );

  } catch (error) {
    console.error(error);
  }
});


/* =========================
   ページ
========================= */

app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "admin.html"
    )
  );
});


/* =========================
   起動
========================= */

async function start() {
  try {
    await initializeDatabase();

    server.listen(
      PORT,
      () => {
        console.log(
          `Server started on port ${PORT}`
        );
      }
    );

  } catch (error) {
    console.error(
      "起動失敗:",
      error
    );

    process.exit(1);
  }
}

start();