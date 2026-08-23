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
    service: "SnapVibe 3.4",
    waiting: waitingQueue.size,
    matches: matches.size,
    connected: connected.size,
    users: db.users.size,
    time: new Date().toISOString()
  });
});

function makeId(prefix) {
  return prefix + crypto.randomUUID();
}

function send(ws, data) {
  if (ws?.readyState !== WebSocket.OPEN) {
    return false;
  }

  try {
    ws.send(JSON.stringify(data));
    return true;
  } catch (error) {
    console.error("SEND ERROR:", error);
    return false;
  }
}

function sendUser(userId, data) {
  return send(
    connected.get(userId),
    data
  );
}

function normalizeCountry(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function getProfile(userId) {
  return (
    db.publicUser(userId) || {
      id: userId,
      name: "SnapVibe User",
      language: "ru",
      age: null,
      gender: "other",
      country: "",
      avatar: ""
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
    Buffer.byteLength(
      value,
      "utf8"
    ) <=
      6 * 1024 * 1024
  );
}

function preferenceAllows(
  preference,
  candidateProfile
) {
  const wantedGender =
    preference?.gender || "all";

  if (
    wantedGender !== "all" &&
    candidateProfile.gender !== wantedGender
  ) {
    return false;
  }

  const minAge =
    Number(
      preference?.ageMin || 18
    );

  const maxAge =
    Number(
      preference?.ageMax || 99
    );

  const candidateAge =
    Number(
      candidateProfile.age || 0
    );

  if (
    candidateAge &&
    (
      candidateAge < minAge ||
      candidateAge > maxAge
    )
  ) {
    return false;
  }

  const wantedCountry =
    normalizeCountry(
      preference?.country
    );

  const candidateCountry =
    normalizeCountry(
      candidateProfile.country
    );

  if (
    wantedCountry &&
    wantedCountry !== "all" &&
    candidateCountry !== wantedCountry
  ) {
    return false;
  }

  return true;
}

function mutuallyCompatible(
  userA,
  userB
) {
  const profileA =
    getProfile(
      userA.userId
    );

  const profileB =
    getProfile(
      userB.userId
    );

  return (
    preferenceAllows(
      userA.search,
      profileB
    ) &&
    preferenceAllows(
      userB.search,
      profileA
    ) &&
    !db.isBlockedEitherWay(
      userA.userId,
      userB.userId
    )
  );
}

function findOpponent(currentUser) {
  let best = null;

  for (
    const [userId, waitingUser]
    of waitingQueue
  ) {
    if (
      userId ===
      currentUser.userId
    ) {
      continue;
    }

    if (
      !waitingUser.ws ||
      waitingUser.ws.readyState !==
        WebSocket.OPEN
    ) {
      waitingQueue.delete(
        userId
      );

      continue;
    }

    if (
      waitingUser.emotionHash !==
      currentUser.emotionHash
    ) {
      continue;
    }

    if (
      !mutuallyCompatible(
        currentUser,
        waitingUser
      )
    ) {
      continue;
    }

    if (
      !best ||
      waitingUser.queuedAt <
        best.queuedAt
    ) {
      best =
        waitingUser;
    }
  }

  return best;
}

function serializeMatchFor(
  userId,
  match
) {
  const isUserA =
    match.userA.userId === userId;

  const partner =
    isUserA
      ? match.userB
      : match.userA;

  return {
    matchId:
      match.matchId,

    matchChatId:
      match.chatId,

    expiresAt:
      match.expiresAt,

    partnerUserId:
      partner.userId,

    partnerName:
      partner.name,

    partnerProfile:
      getProfile(
        partner.userId
      ),

    partnerPhoto:
      partner.photo,

    keepMine:
      match.keep.has(
        userId
      ),

    keepPartner:
      match.keep.has(
        partner.userId
      )
  };
}

function createMatch(
  userA,
  userB
) {
  const matchId =
    makeId("match_");

  const createdAt =
    Date.now();

  const expiresAt =
    createdAt +
    MATCH_TIME;

  const profileA =
    getProfile(
      userA.userId
    );

  const profileB =
    getProfile(
      userB.userId
    );

  const chat =
    db.createMatchChat(
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
      userId:
        userA.userId,

      name:
        profileA.name,

      photo:
        userA.photo
    },

    userB: {
      userId:
        userB.userId,

      name:
        profileB.name,

      photo:
        userB.photo
    },

    keep:
      new Set(),

    timer:
      null
  };

  matches.set(
    matchId,
    match
  );

  userMatches.set(
    userA.userId,
    matchId
  );

  userMatches.set(
    userB.userId,
    matchId
  );

  waitingQueue.delete(
    userA.userId
  );

  waitingQueue.delete(
    userB.userId
  );

  send(
    userA.ws,
    {
      type:
        "match_found",

      ...serializeMatchFor(
        userA.userId,
        match
      )
    }
  );

  send(
    userB.ws,
    {
      type:
        "match_found",

      ...serializeMatchFor(
        userB.userId,
        match
      )
    }
  );

  match.timer =
    setTimeout(
      () => {
        expireMatch(
          matchId
        );
      },
      MATCH_TIME
    );
}

function expireMatch(matchId) {
  const match =
    matches.get(
      matchId
    );

  if (!match) {
    return;
  }

  if (match.timer) {
    clearTimeout(
      match.timer
    );
  }

  const userIds = [
    match.userA.userId,
    match.userB.userId
  ];

  userIds.forEach(
    userId => {
      userMatches.delete(
        userId
      );

      sendUser(
        userId,
        {
          type:
            "match_expired",

          matchId
        }
      );
    }
  );

  db.deleteChat(
    match.chatId
  );

  match.userA.photo =
    null;

  match.userB.photo =
    null;

  matches.delete(
    matchId
  );
}

function handleCapture(
  ws,
  message
) {
  if (
    !validHash(
      message.emotionHash
    )
  ) {
    return send(
      ws,
      {
        type: "error",
        message:
          "Некорректная эмоция"
      }
    );
  }

  if (
    !validPhoto(
      message.photo
    )
  ) {
    return send(
      ws,
      {
        type: "error",
        message:
          "Некорректное фото"
      }
    );
  }

  if (
    userMatches.has(
      ws.userId
    )
  ) {
    return send(
      ws,
      {
        type: "error",
        message:
          "У вас уже есть активный мэтч."
      }
    );
  }

  waitingQueue.delete(
    ws.userId
  );

  const currentUser = {
    userId:
      ws.userId,

    ws,

    emotionHash:
      message.emotionHash,

    photo:
      message.photo,

    queuedAt:
      Date.now(),

    search: {
      gender:
        [
          "male",
          "female",
          "all"
        ].includes(
          message.searchGender
        )
          ? message.searchGender
          : "all",

      ageMin:
        Math.max(
          18,
          Math.min(
            99,
            Number(
              message.ageMin
            ) || 18
          )
        ),

      ageMax:
        Math.max(
          18,
          Math.min(
            99,
            Number(
              message.ageMax
            ) || 99
          )
        ),

      country:
        String(
          message.searchCountry ||
          ""
        )
    }
  };

  if (
    currentUser.search.ageMin >
    currentUser.search.ageMax
  ) {
    [
      currentUser.search.ageMin,
      currentUser.search.ageMax
    ] = [
      currentUser.search.ageMax,
      currentUser.search.ageMin
    ];
  }

  const opponent =
    findOpponent(
      currentUser
    );

  if (!opponent) {
    waitingQueue.set(
      ws.userId,
      currentUser
    );

    return send(
      ws,
      {
        type:
          "searching"
      }
    );
  }

  createMatch(
    opponent,
    currentUser
  );
}

function keepVibe(
  ws,
  message
) {
  const match =
    matches.get(
      String(
        message.matchId ||
        ""
      )
    );

  if (!match) {
    return send(
      ws,
      {
        type: "error",
        message:
          "Мэтч уже закончился"
      }
    );
  }

  const users = [
    match.userA.userId,
    match.userB.userId
  ];

  if (
    !users.includes(
      ws.userId
    )
  ) {
    return;
  }

  const otherUserId =
    users.find(
      userId =>
        userId !==
        ws.userId
    );

  const senderProfile =
    getProfile(
      ws.userId
    );

  const otherProfile =
    getProfile(
      otherUserId
    );

  if (
    match.keep.has(
      ws.userId
    )
  ) {
    return send(
      ws,
      {
        type:
          "keep_vibe_pending",

        matchId:
          match.matchId,

        already:
          true
      }
    );
  }

  match.keep.add(
    ws.userId
  );

  send(
    ws,
    {
      type:
        "keep_vibe_pending",

      matchId:
        match.matchId
    }
  );

  sendUser(
    otherUserId,
    {
      type:
        "keep_vibe_received",

      matchId:
        match.matchId,

      fromUserId:
        ws.userId,

      fromName:
        senderProfile.name,

      fromAvatar:
        senderProfile.avatar,

      message:
        senderProfile.name +
        " хочет сохранить связь с тобой 💗"
    }
  );

  if (
    match.keep.size === 2
  ) {
    db.makeFriends(
      users[0],
      users[1]
    );

    const permanentChat =
      db.createFriendChat(
        users[0],
        users[1]
      );

    sendUser(
      users[0],
      {
        type:
          "keep_vibe_mutual",

        matchId:
          match.matchId,

        friend:
          getProfile(
            users[1]
          ),

        chatId:
          permanentChat.id
      }
    );

    sendUser(
      users[1],
      {
        type:
          "keep_vibe_mutual",

        matchId:
          match.matchId,

        friend:
          getProfile(
            users[0]
          ),

        chatId:
          permanentChat.id
      }
    );

    sendUser(
      users[0],
      {
        type:
          "friendship_created",

        friend:
          getProfile(
            users[1]
          ),

        chatId:
          permanentChat.id
      }
    );

    sendUser(
      users[1],
      {
        type:
          "friendship_created",

        friend:
          getProfile(
            users[0]
          ),

        chatId:
          permanentChat.id
      }
    );
  }
}

function handleChatMessage(
  ws,
  message
) {
  const chat =
    db.getChat(
      String(
        message.chatId ||
        ""
      )
    );

  if (
    !chat ||
    !chat.users.includes(
      ws.userId
    )
  ) {
    return;
  }

  if (
    chat.type ===
    "match"
  ) {
    const match =
      matches.get(
        chat.matchId
      );

    if (
      !match ||
      Date.now() >=
        match.expiresAt
    ) {
      return send(
        ws,
        {
          type: "error",
          message:
            "Чат мэтча уже закрыт"
        }
      );
    }
  }

  if (
    chat.type ===
    "friend"
  ) {
    const otherUserId =
      chat.users.find(
        userId =>
          userId !==
          ws.userId
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

  const savedMessage =
    db.addMessage(
      chat.id,
      ws.userId,
      message.text
    );

  if (!savedMessage) {
    return;
  }

  const senderProfile =
    getProfile(
      ws.userId
    );

  const fullMessage = {
    ...savedMessage,

    senderName:
      senderProfile.name,

    senderAvatar:
      senderProfile.avatar
  };

  chat.users.forEach(
    userId => {
      sendUser(
        userId,
        {
          type:
            "chat_message",

          chatId:
            chat.id,

          message:
            fullMessage
        }
      );
    }
  );
}

wss.on(
  "connection",
  ws => {
    ws.userId =
      makeId(
        "session_"
      );

    send(
      ws,
      {
        type:
          "connected",

        sessionId:
          ws.userId
      }
    );

    ws.on(
      "message",
      raw => {
        try {
          const message =
            JSON.parse(
              raw.toString()
            );

          if (
            message.type ===
            "register_profile"
          ) {
            const userId =
              typeof message.userId ===
                "string" &&
              message.userId.length >=
                10 &&
              message.userId.length <=
                120
                ? message.userId
                : makeId(
                    "user_"
                  );

            if (
              connected.get(
                ws.userId
              ) === ws
            ) {
              connected.delete(
                ws.userId
              );
            }

            ws.userId =
              userId;

            connected.set(
              userId,
              ws
            );

            const savedProfile =
              db.createOrUpdateUser({
                id:
                  userId,

                name:
                  message.name,

                language:
                  message.language,

                age:
                  message.age,

                gender:
                  message.gender,

                country:
                  message.country,

                avatar:
                  message.avatar
              });

            const activeMatchId =
              userMatches.get(
                userId
              );

            const activeMatch =
              activeMatchId
                ? matches.get(
                    activeMatchId
                  )
                : null;

            send(
              ws,
              {
                type:
                  "profile_saved",

                profile:
                  savedProfile
              }
            );

            send(
              ws,
              {
                type:
                  "bootstrap",

                profile:
                  savedProfile,

                friends:
                  db.getFriends(
                    userId
                  ),

                activeMatch:
                  activeMatch
                    ? serializeMatchFor(
                        userId,
                        activeMatch
                      )
                    : null
              }
            );

            return;
          }

          if (
            message.type ===
            "capture"
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

            return send(
              ws,
              {
                type:
                  "search_cancelled"
              }
            );
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
                message.matchId ||
                ""
              );

            const match =
              matches.get(
                matchId
              );

            if (
              match &&
              [
                match.userA.userId,
                match.userB.userId
              ].includes(
                ws.userId
              )
            ) {
              expireMatch(
                matchId
              );
            } else {
              userMatches.delete(
                ws.userId
              );
            }

            return send(
              ws,
              {
                type:
                  "match_ended"
              }
            );
          }

          if (
            message.type ===
            "chat_message"
          ) {
            return handleChatMessage(
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
                  message.chatId ||
                  ""
                )
              );

            if (
              chat &&
              chat.users.includes(
                ws.userId
              )
            ) {
              const history =
                db.getMessages(
                  chat.id
                ).map(
                  item => {
                    const sender =
                      getProfile(
                        item.senderId
                      );

                    return {
                      ...item,

                      senderName:
                        sender.name,

                      senderAvatar:
                        sender.avatar
                    };
                  }
                );

              return send(
                ws,
                {
                  type:
                    "chat_history",

                  chatId:
                    chat.id,

                  messages:
                    history
                }
              );
            }

            return;
          }

          if (
            message.type ===
            "friends_list"
          ) {
            return send(
              ws,
              {
                type:
                  "friends_list",

                friends:
                  db.getFriends(
                    ws.userId
                  )
              }
            );
          }

          if (
            message.type ===
            "friend_chat_open"
          ) {
            const friendId =
              String(
                message.friendId ||
                ""
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

              const history =
                db.getMessages(
                  chat.id
                ).map(
                  item => {
                    const sender =
                      getProfile(
                        item.senderId
                      );

                    return {
                      ...item,

                      senderName:
                        sender.name,

                      senderAvatar:
                        sender.avatar
                    };
                  }
                );

              return send(
                ws,
                {
                  type:
                    "friend_chat_ready",

                  chatId:
                    chat.id,

                  friend:
                    getProfile(
                      friendId
                    ),

                  messages:
                    history
                }
              );
            }

            return;
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

            return send(
              ws,
              {
                type:
                  "report_received"
              }
            );
          }

          if (
            message.type ===
            "ping"
          ) {
            return send(
              ws,
              {
                type:
                  "pong",

                time:
                  Date.now()
              }
            );
          }
        } catch (error) {
          console.error(
            "MESSAGE ERROR:",
            error
          );

          send(
            ws,
            {
              type:
                "error",

              message:
                "Ошибка запроса"
            }
          );
        }
      }
    );

    ws.on(
      "close",
      () => {
        waitingQueue.delete(
          ws.userId
        );

        if (
          connected.get(
            ws.userId
          ) === ws
        ) {
          connected.delete(
            ws.userId
          );
        }
      }
    );
  }
);

setInterval(
  () => {
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
  },
  60000
);

server.listen(
  PORT,
  () => {
    console.log(
      `SnapVibe 3.4 running on port ${PORT}`
    );
  }
);
