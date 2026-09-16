const socket = io();

const messagesElement = document.getElementById("messages");
const form = document.getElementById("message-form");
const nameInput = document.getElementById("name");
const contentInput = document.getElementById("content");
const siteTitle = document.getElementById("site-title");

let anonymousMode = true;

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function updateHeader() {
  if (anonymousMode) {
    siteTitle.textContent = "匿名掲示板";
    siteTitle.classList.remove("not-anonymous");
  } else {
    siteTitle.textContent = "Not 匿名掲示板";
    siteTitle.classList.add("not-anonymous");
  }

  document.title = anonymousMode
    ? "匿名掲示板"
    : "Not 匿名掲示板";
}

function renderMessages(messages) {
  messagesElement.innerHTML = "";

  for (const message of messages) {
    const article = document.createElement("article");
    article.className = "message";

    const user = document.createElement("div");
    user.className = "message-user";

    /*
     * 匿名モードONの場合、サーバーから user_name 自体が
     * 送られてこないので、ここでも名前を取得できない。
     */
    if (anonymousMode) {
      user.textContent = "匿名";
    } else {
      user.textContent = message.user_name || "不明";
    }

    const body = document.createElement("div");
    body.className = "message-content";
    body.innerHTML = escapeHtml(message.content).replace(/\n/g, "<br>");

    const time = document.createElement("time");
    time.className = "message-time";

    if (message.created_at) {
      time.textContent = new Date(
        message.created_at
      ).toLocaleString("ja-JP");
    }

    article.appendChild(user);
    article.appendChild(body);
    article.appendChild(time);

    messagesElement.appendChild(article);
  }

  messagesElement.scrollTop = messagesElement.scrollHeight;
}

socket.on("initial_data", data => {
  anonymousMode = data.anonymous_mode;
  updateHeader();
  renderMessages(data.messages);
});

socket.on("anonymous_mode_changed", data => {
  anonymousMode = data.anonymous_mode;

  updateHeader();
});

socket.on("messages_updated", data => {
  anonymousMode = data.anonymous_mode;

  updateHeader();
  renderMessages(data.messages);
});

form.addEventListener("submit", async event => {
  event.preventDefault();

  const name = nameInput.value.trim();
  const content = contentInput.value.trim();

  if (!name || !content) {
    return;
  }

  const button = form.querySelector("button");

  button.disabled = true;

  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name,
        content
      })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.error || "送信に失敗しました");
      return;
    }

    contentInput.value = "";
    contentInput.focus();

  } catch (error) {
    alert("サーバーに接続できませんでした");
  } finally {
    button.disabled = false;
  }
});