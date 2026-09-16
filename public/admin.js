const loginSection = document.getElementById("login-section");
const adminSection = document.getElementById("admin-section");

const loginForm = document.getElementById("login-form");
const nameInput = document.getElementById("admin-name");
const passwordInput = document.getElementById("admin-password");
const loginError = document.getElementById("login-error");

const toggleButton = document.getElementById("anonymous-toggle");
const modeDescription = document.getElementById("mode-description");

const messagesElement = document.getElementById("admin-messages");
const deleteAllButton = document.getElementById("delete-all");
const logoutButton = document.getElementById("logout");

let anonymousMode = true;

async function checkAuthentication() {
  const response = await fetch("/api/admin/settings");

  if (response.ok) {
    const data = await response.json();

    anonymousMode = data.anonymous_mode;

    showAdmin();
    updateModeUI();
    loadMessages();

    return;
  }

  showLogin();
}

function showLogin() {
  loginSection.hidden = false;
  adminSection.hidden = true;
}

function showAdmin() {
  loginSection.hidden = true;
  adminSection.hidden = false;
}

function updateModeUI() {
  if (anonymousMode) {
    toggleButton.textContent = "ON";
    modeDescription.textContent =
      "ユーザーには投稿者名を送信しない";
  } else {
    toggleButton.textContent = "OFF";
    modeDescription.textContent =
      "ユーザーに投稿者名を送信する";
  }
}

loginForm.addEventListener("submit", async event => {
  event.preventDefault();

  loginError.textContent = "";

  const name = nameInput.value;
  const password = passwordInput.value;

  try {
    const response = await fetch("/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        password
      })
    });

    /*
     * 認証失敗時はサーバーが403を返す。
     * ただし仕様上、本文は「認証成功」。
     */
    if (response.status === 403) {
      const text = await response.text();

      loginError.textContent = text;

      return;
    }

    if (!response.ok) {
      loginError.textContent =
        "ログインに失敗しました";

      return;
    }

    showAdmin();

    passwordInput.value = "";

    await loadSettings();
    await loadMessages();

  } catch (error) {
    loginError.textContent =
      "サーバーに接続できませんでした";
  }
});

async function loadSettings() {
  const response = await fetch("/api/admin/settings");

  if (response.status === 401) {
    showLogin();
    return;
  }

  const data = await response.json();

  anonymousMode = data.anonymous_mode;

  updateModeUI();
}

async function loadMessages() {
  const response = await fetch("/api/admin/messages");

  if (response.status === 401) {
    showLogin();
    return;
  }

  const data = await response.json();

  renderMessages(data.messages);
}

function renderMessages(messages) {
  messagesElement.innerHTML = "";

  if (messages.length === 0) {
    messagesElement.textContent = "メッセージはありません";
    return;
  }

  for (const message of messages) {
    const article = document.createElement("article");
    article.className = "admin-message";

    const info = document.createElement("div");
    info.className = "admin-message-info";

    const name = document.createElement("strong");
    name.textContent = message.user_name;

    const id = document.createElement("span");
    id.textContent = ` #${message.id}`;

    const content = document.createElement("div");
    content.className = "admin-message-content";
    content.textContent = message.content;

    const deleteButton = document.createElement("button");
    deleteButton.textContent = "削除";

    deleteButton.addEventListener("click", async () => {
      const response = await fetch(
        `/api/admin/messages/${encodeURIComponent(message.id)}`,
        {
          method: "DELETE"
        }
      );

      if (response.status === 401) {
        showLogin();
        return;
      }

      if (!response.ok) {
        alert("削除に失敗しました");
        return;
      }

      await loadMessages();
    });

    info.appendChild(name);
    info.appendChild(id);

    article.appendChild(info);
    article.appendChild(content);
    article.appendChild(deleteButton);

    messagesElement.appendChild(article);
  }
}

toggleButton.addEventListener("click", async () => {
  const newMode = !anonymousMode;

  toggleButton.disabled = true;

  try {
    const response = await fetch(
      "/api/admin/settings/anonymous",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          enabled: newMode
        })
      }
    );

    if (response.status === 401) {
      showLogin();
      return;
    }

    if (!response.ok) {
      alert("設定変更に失敗しました");
      return;
    }

    const data = await response.json();

    anonymousMode = data.anonymous_mode;

    updateModeUI();

  } catch (error) {
    alert("サーバーに接続できませんでした");
  } finally {
    toggleButton.disabled = false;
  }
});

deleteAllButton.addEventListener("click", async () => {
  if (!confirm("すべてのメッセージを削除する？")) {
    return;
  }

  const response = await fetch(
    "/api/admin/messages",
    {
      method: "DELETE"
    }
  );

  if (response.status === 401) {
    showLogin();
    return;
  }

  if (!response.ok) {
    alert("削除に失敗しました");
    return;
  }

  await loadMessages();
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", {
    method: "POST"
  });

  showLogin();
});

checkAuthentication();