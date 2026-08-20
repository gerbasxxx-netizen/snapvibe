const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const PORT = process.env.PORT || 3000;
const MATCH_TIME = 24 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  maxPayload: 8 * 1024 * 1024
});

const waitingQueue = new Map();
const matches = new Map();
const userMatches = new Map();

app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    waiting: waitingQueue.size,
    matches: matches.size
  });
});

function id(prefix) {
  return prefix + crypto.randomUUID();
}

function send(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(data));
}

function validEmotionHash(hash) {
  return (
    typeof hash === "string" &&
    /^[a-f0-9]{64}$/i.test(hash)
  );
}

function validPhoto(photo) {
  return (
    typeof photo === "string" &&
    photo.startsWith("data:image/") &&
    Buffer.byteLength(photo, "utf8") <= 6 * 1024 * 1024
  );
}

function findWaitingUser(emotionHash, currentUserId) {
  for (const user of waitingQueue.values()) {
    if (user.userId === currentUserId) {
      continue;
    }

    if (user.emotionHash !== emotionHash) {
      continue;
    }

    if (
      user.ws &&
      user.ws.readyState === WebSocket.OPEN
    ) {
      return user;
    }

    waitingQueue.delete(user.userId);
  }

  return null;
}

function createMatch(userA, userB) {
  const matchId = id("match_");
  const createdAt = Date.now();
  const expiresAt = createdAt + MATCH_TIME;

  const match = {
    matchId,
    createdAt,
    expiresAt,
    userA: {
      userId: userA.userId,
      photo: userA.photo
    },
    userB: {
      userId: userB.userId,
      photo: userB.photo
    },
    timer: null
  };

  matches.set(matchId, match);

  userMatches.set(
    userA.userId,
    matchId
  );

  userMatches.set(
    userB.userId,
    matchId
  );

  waitingQueue.delete(userA.userId);
  waitingQueue.delete(userB.userId);

  send(userA.ws, {
    type: "match_found",
    matchId,
    expiresAt,
    partnerUserId: userB.userId,
    partnerPhoto: userB.photo
  });

  send(userB.ws, {
    type: "match_found",
    matchId,
    expiresAt,
    partnerUserId: userA.userId,
    partnerPhoto: userA.photo
  });

  console.log(
    "MATCH:",
    userA.userId,
    "<->",
    userB.userId
  );

  match.timer = setTimeout(() => {
    expireMatch(matchId);
  }, MATCH_TIME);
}

function expireMatch(matchId) {
  const match = matches.get(matchId);

  if (!match) {
    return;
  }

  if (match.timer) {
    clearTimeout(match.timer);
  }

  const userIds = [
    match.userA.userId,
    match.userB.userId
  ];

  for (const userId of userIds) {
    userMatches.delete(userId);

    for (const client of wss.clients) {
      if (
        client.userId === userId &&
        client.readyState === WebSocket.OPEN
      ) {
        send(client, {
          type: "match_expired",
          matchId
        });
      }
    }
  }

  match.userA.photo = null;
  match.userB.photo = null;

  matches.delete(matchId);

  console.log(
    "MATCH EXPIRED:",
    matchId
  );
}

function handleCapture(ws, data) {
  if (!validEmotionHash(data.emotionHash)) {
    send(ws, {
      type: "error",
      message: "Некорректный хэш эмоции."
    });

    return;
  }

  if (!validPhoto(data.photo)) {
    send(ws, {
      type: "error",
      message: "Некорректное фото или слишком большой файл."
    });

    return;
  }

  if (userMatches.has(ws.userId)) {
    send(ws, {
      type: "error",
      message: "У вас уже есть активный мэтч."
    });

    return;
  }

  waitingQueue.delete(ws.userId);

  const user = {
    userId: ws.userId,
    ws,
    emotionHash: data.emotionHash,
    photo: data.photo,
    queuedAt: Date.now()
  };

  const opponent = findWaitingUser(
    user.emotionHash,
    user.userId
  );

  if (!opponent) {
    waitingQueue.set(
      user.userId,
      user
    );

    send(ws, {
      type: "searching"
    });

    console.log(
      "WAITING:",
      user.userId
    );

    return;
  }

  createMatch(
    opponent,
    user
  );
}

wss.on("connection", (ws) => {
  const userId = id("user_");

  ws.userId = userId;

  console.log(
    "CONNECTED:",
    userId
  );

  send(ws, {
    type: "connected",
    userId
  });

  ws.on("message", (raw) => {
    try {
      const message =
        JSON.parse(
          raw.toString()
        );
if (message.type === "register_profile") {
  const requestedUserId =
    typeof message.userId === "string" &&
    message.userId.length >= 10 &&
    message.userId.length <= 100
      ? message.userId
      : ws.userId;

  ws.userId = requestedUserId;

  const profile = db.createUser({
    id: requestedUserId,
    name:
      typeof message.name === "string"
        ? message.name.trim().slice(0, 30)
        : "SnapVibe User",
    avatar:
      typeof message.avatar === "string"
        ? message.avatar
        : null,
    language:
      typeof message.language === "string"
        ? message.language.slice(0, 5)
        : "en"
  });

  send(ws, {
    type: "profile_saved",
    profile
  });

  return;
}
      if (message.type === "capture") {
        handleCapture(
          ws,
          message
        );

        return;
      }

      if (message.type === "cancel_search") {
        waitingQueue.delete(
          ws.userId
        );

        send(ws, {
          type: "search_cancelled"
        });

        return;
      }

      if (message.type === "ping") {
        send(ws, {
          type: "pong"
        });

        return;
      }

      send(ws, {
        type: "error",
        message: "Неизвестная команда."
      });

    } catch (error) {
      console.error(
        "MESSAGE ERROR:",
        error
      );

      send(ws, {
        type: "error",
        message: "Ошибка обработки данных."
      });
    }
  });

  ws.on("close", () => {
    waitingQueue.delete(
      ws.userId
    );

    console.log(
      "DISCONNECTED:",
      ws.userId
    );
  });

  ws.on("error", (error) => {
    console.error(
      "WEBSOCKET ERROR:",
      error
    );
  });
});

setInterval(() => {
  for (const [userId, user] of waitingQueue) {
    if (
      !user.ws ||
      user.ws.readyState !== WebSocket.OPEN
    ) {
      waitingQueue.delete(userId);
    }
  }
}, 60000);

function shutdown() {
  console.log(
    "Stopping SnapVibe..."
  );

  for (const match of matches.values()) {
    if (match.timer) {
      clearTimeout(match.timer);
    }

    match.userA.photo = null;
    match.userB.photo = null;
  }

  matches.clear();
  waitingQueue.clear();
  userMatches.clear();

  process.exit(0);
}

process.on(
  "SIGINT",
  shutdown
);

process.on(
  "SIGTERM",
  shutdown
);

server.listen(
  PORT,
  () => {
    console.log(
      `SnapVibe server started on port ${PORT}`
    );
  }
);
