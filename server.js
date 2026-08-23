const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
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
const connected = new Map();

app.use(express.static(__dirname));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "SnapVibe 2.1",
    waiting: waitingQueue.size,
    matches: matches.size,
    connected: connected.size,
    users: db.users.size,
    time: new Date().toISOString()
  });
});

const id = (prefix) => prefix + crypto.randomUUID();

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (error) {
      console.error("Send error:", error);
    }
  }

  return false;
}

function sendUser(userId, data) {
  return send(connected.get(userId), data);
}

function profile(userId) {
  return (
    db.publicUser(userId) || {
      id: userId,
      name: "SnapVibe User",
      language: "en"
    }
  );
}

function validHash(value) {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{64}$/i.test(value)
  );
}

function validPhoto(value) {
  return (
    typeof value === "string" &&
    value.startsWith("data:image/") &&
    Buffer.byteLength(value, "utf8") <= 6 * 1024 * 1024
  );
}

function findOpponent(hash, currentId) {
  let best = null;

  for (const [userId, user] of waitingQueue) {
    if (userId === currentId) {
      continue;
    }

    if (!user.ws || user.ws.readyState !== WebSocket.OPEN) {
      waitingQueue.delete(userId);
      continue;
    }

    if (user.emotionHash !== hash) {
      continue;
    }

    if (db.isBlockedEitherWay(userId, currentId)) {
      continue;
    }

    if (!best || user.queuedAt < best.queuedAt) {
      best = user;
    }
  }

  return best;
}

function createMatch(userA, userB) {
  const matchId = id("match_");
  const createdAt = Date.now();
  const expiresAt = createdAt + MATCH_TIME;

  const profileA = profile(userA.userId);
  const profileB = profile(userB.userId);

  const chat = db.createMatchChat(
    matchId,
    userA.userId,
    userB.userId
  );

  const match = {
    matchId,
    createdAt,
    expiresAt,
    chatId: chat.id,

    userA: {
      userId: userA.userId,
      name: profileA.name,
      photo: userA.photo
    },

    userB: {
      userId: userB.userId,
      name: profileB.name,
      photo: userB.photo
    },

    keep: new Set(),
    timer: null
  };

  matches.set(matchId, match);

  userMatches.set(userA.userId, matchId);
  userMatches.set(userB.userId, matchId);

  waitingQueue.delete(userA.userId);
  waitingQueue.delete(userB.userId);

  send(userA.ws, {
    type: "match_found",
    matchId,
    matchChatId: chat.id,
    expiresAt,

    partnerUserId: userB.userId,
    partnerName: profileB.name,
    partnerProfile: profileB,
    partnerPhoto: userB.photo
  });

  send(userB.ws, {
    type: "match_found",
    matchId,
    matchChatId: chat.id,
    expiresAt,

    partnerUserId: userA.userId,
    partnerName: profileA.name,
    partnerProfile: profileA,
    partnerPhoto: userA.photo
  });

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

  const users = [
    match.userA.userId,
    match.userB.userId
  ];

  for (const userId of users) {
    userMatches.delete(userId);

    sendUser(userId, {
      type: "match_expired",
      matchId
    });
  }

  match.userA.photo = null;
  match.userB.photo = null;

  db.deleteChat(match.chatId);

  matches.delete(matchId);
}

function handleCapture(ws, message) {
  if (!validHash(message.emotionHash)) {
    return send(ws, {
      type: "error",
      message: "Invalid emotion hash"
    });
  }

  if (!validPhoto(message.photo)) {
    return send(ws, {
      type: "error",
      message: "Invalid photo"
    });
  }

  if (userMatches.has(ws.userId)) {
    return send(ws, {
      type: "error",
      message:
        "У вас уже есть активный мэтч. Нажмите «Найти новый мэтч», чтобы завершить его."
    });
  }

  waitingQueue.delete(ws.userId);

  const currentProfile = profile(ws.userId);

  const user = {
    userId: ws.userId,
    name: currentProfile.name,
    ws,
    emotionHash: message.emotionHash,
    photo: message.photo,
    queuedAt: Date.now()
  };

  const opponent = findOpponent(
    user.emotionHash,
    user.userId
  );

  if (!opponent) {
    waitingQueue.set(user.userId, user);

    send(ws, {
      type: "searching"
    });

    return;
  }

  createMatch(opponent, user);
}

function keepVibe(ws, message) {
  const match = matches.get(message.matchId);

  if (!match) {
    return send(ws, {
      type: "error",
      message: "Match expired"
    });
  }

  const users = [
    match.userA.userId,
    match.userB.userId
  ];

  if (!users.includes(ws.userId)) {
    return;
  }

  const otherUserId =
    users.find((userId) => userId !== ws.userId);

  match.keep.add(ws.userId);

  send(ws, {
    type: "keep_vibe_pending",
    matchId: match.matchId
  });

  sendUser(otherUserId, {
    type: "keep_vibe_received",
    matchId: match.matchId
  });

  if (match.keep.size === 2) {
    db.makeFriends(
      users[0],
      users[1]
    );

    const chat = db.createFriendChat(
      users[0],
      users[1]
    );

    sendUser(users[0], {
      type: "friendship_created",
      friend: profile(users[1]),
      chatId: chat.id
    });

    sendUser(users[1], {
      type: "friendship_created",
      friend: profile(users[0]),
      chatId: chat.id
    });
  }
}

function chatMessage(ws, message) {
  const chat = db.getChat(
    String(message.chatId || "")
  );

  if (!chat) {
    return;
  }

  if (!chat.users.includes(ws.userId)) {
    return;
  }

  if (chat.type === "match") {
    const match = matches.get(chat.matchId);

    if (
      !match ||
      Date.now() >= match.expiresAt
    ) {
      return send(ws, {
        type: "error",
        message: "Match chat expired"
      });
    }
  }

  if (chat.type === "friend") {
    const otherUserId =
      chat.users.find(
        (userId) => userId !== ws.userId
      );

    if (
      !db.areFriends(
        ws.userId,
        otherUserId
      )
    ) {
      return;
    }
  }

  const newMessage = db.addMessage(
    chat.id,
    ws.userId,
    message.text
  );

  if (!newMessage) {
    return;
  }

  chat.users.forEach((userId) => {
    sendUser(userId, {
      type: "chat_message",
      chatId: chat.id,
      message: newMessage
    });
  });
}

wss.on("connection", (ws) => {
  ws.userId = id("session_");

  send(ws, {
    type: "connected",
    sessionId: ws.userId
  });

  ws.on("message", (raw) => {
    try {
      const message =
        JSON.parse(raw.toString());

      if (
        message.type ===
        "register_profile"
      ) {
        const userId =
          typeof message.userId === "string" &&
          message.userId.length >= 10 &&
          message.userId.length <= 120
            ? message.userId
            : id("user_");

        if (
          connected.get(ws.userId) === ws
        ) {
          connected.delete(ws.userId);
        }

        ws.userId = userId;

        connected.set(
          userId,
          ws
        );

        const savedProfile =
          db.createOrUpdateUser({
            id: userId,
            name: message.name,
            language: message.language,
            age: message.age,
            gender: message.gender,
            country: message.country
          });

        send(ws, {
          type: "profile_saved",
          profile: savedProfile
        });

        send(ws, {
          type: "bootstrap",
          profile: savedProfile,
          friends:
            db.getFriends(userId)
        });

        return;
      }

      if (
        message.type === "capture"
      ) {
        return handleCapture(
          ws,
          message
        );
      }

      if (
        message.type ===
        "cancel_search"
      ) {
        waitingQueue.delete(
          ws.userId
        );

        return send(ws, {
          type: "search_cancelled"
        });
      }

      if (
        message.type ===
        "keep_vibe"
      ) {
        return keepVibe(
          ws,
          message
        );
      }

      if (
        message.type ===
        "end_match"
      ) {
        const matchId =
          String(
            message.matchId || ""
          );

        const match =
          matches.get(matchId);

        if (
          match &&
          (
            match.userA.userId ===
              ws.userId ||
            match.userB.userId ===
              ws.userId
          )
        ) {
          expireMatch(matchId);
        } else {
          userMatches.delete(
            ws.userId
          );
        }

        return send(ws, {
          type: "match_ended"
        });
      }

      if (
        message.type ===
        "chat_message"
      ) {
        return chatMessage(
          ws,
          message
        );
      }

      if (
        message.type ===
        "chat_history"
      ) {
        const chat =
          db.getChat(
            String(
              message.chatId || ""
            )
          );

        if (
          chat &&
          chat.users.includes(
            ws.userId
          )
        ) {
          send(ws, {
            type: "chat_history",
            chatId: chat.id,
            messages:
              db.getMessages(
                chat.id
              )
          });
        }

        return;
      }

      if (
        message.type ===
        "friends_list"
      ) {
        return send(ws, {
          type: "friends_list",
          friends:
            db.getFriends(
              ws.userId
            )
        });
      }

      if (
        message.type ===
        "friend_chat_open"
      ) {
        const friendId =
          String(
            message.friendId || ""
          );

        if (
          db.areFriends(
            ws.userId,
            friendId
          )
        ) {
          const chat =
            db.createFriendChat(
              ws.userId,
              friendId
            );

          send(ws, {
            type:
              "friend_chat_ready",
            chatId: chat.id,
            friend:
              profile(friendId),
            messages:
              db.getMessages(
                chat.id
              )
          });
        }

        return;
      }

      if (
        message.type ===
        "remove_friend"
      ) {
        const friendId =
          String(
            message.friendId || ""
          );

        db.removeFriend(
          ws.userId,
          friendId
        );

        send(ws, {
          type: "friends_list",
          friends:
            db.getFriends(
              ws.userId
            )
        });

        sendUser(friendId, {
          type: "friends_list",
          friends:
            db.getFriends(
              friendId
            )
        });

        return;
      }

      if (
        message.type ===
        "block_user"
      ) {
        db.blockUser(
          ws.userId,
          String(
            message.targetUserId ||
              ""
          )
        );

        return send(ws, {
          type: "user_blocked"
        });
      }

      if (
        message.type ===
        "report_user"
      ) {
        db.reportUser(
          ws.userId,
          String(
            message.targetUserId ||
              ""
          ),
          message.reason
        );

        return send(ws, {
          type: "report_received"
        });
      }

      if (
        message.type === "ping"
      ) {
        return send(ws, {
          type: "pong",
          time: Date.now()
        });
      }

      send(ws, {
        type: "error",
        message:
          "Unknown command"
      });
    } catch (error) {
      console.error(error);

      send(ws, {
        type: "error",
        message: "Bad request"
      });
    }
  });

  ws.on("close", () => {
    waitingQueue.delete(
      ws.userId
    );

    if (
      connected.get(ws.userId) === ws
    ) {
      connected.delete(
        ws.userId
      );
    }
  });
});

setInterval(() => {
  for (
    const [userId, user]
    of waitingQueue
  ) {
    if (
      !user.ws ||
      user.ws.readyState !==
        WebSocket.OPEN
    ) {
      waitingQueue.delete(
        userId
      );
    }
  }

  for (
    const [matchId, match]
    of matches
  ) {
    if (
      Date.now() >=
      match.expiresAt
    ) {
      expireMatch(
        matchId
      );
    }
  }
}, 60000);

function shutdown() {
  for (
    const match
    of matches.values()
  ) {
    if (match.timer) {
      clearTimeout(
        match.timer
      );
    }

    match.userA.photo = null;
    match.userB.photo = null;
  }

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 3000).unref();
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
      `SnapVibe 2.1 running on port ${PORT}`
    );
  }
);
