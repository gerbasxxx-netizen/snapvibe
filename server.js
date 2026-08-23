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
    service: "SnapVibe 3.3",
    waiting: waitingQueue.size,
    matches: matches.size,
    connected: connected.size,
    users: db.users.size,
    time: new Date().toISOString()
  });
});

const id = (prefix) =>
  prefix + crypto.randomUUID();

function send(ws, data) {
  if (ws?.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (e) {
      console.error("send", e);
    }
  }

  return false;
}

function sendUser(userId, data) {
  return send(
    connected.get(userId),
    data
  );
}

function profile(userId) {
  return (
    db.publicUser(userId) || {
      id: userId,
      name: "SnapVibe User",
      language: "en",
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

function prefAllows(
  pref,
  candidateProfile
) {
  const want =
    pref?.gender || "all";

  if (
    want !== "all" &&
    candidateProfile.gender !== want
  ) {
    return false;
  }

  const min =
    Number(pref?.ageMin || 18);

  const max =
    Number(pref?.ageMax || 99);

  const age =
    Number(
      candidateProfile.age || 0
    );

  if (
    age &&
    (
      age < min ||
      age > max
    )
  ) {
    return false;
  }

  return true;
}

function mutuallyCompatible(
  a,
  b
) {
  const pa =
    profile(a.userId);

  const pb =
    profile(b.userId);

  return (
    prefAllows(
      a.search,
      pb
    ) &&
    prefAllows(
      b.search,
      pa
    ) &&
    !db.isBlockedEitherWay(
      a.userId,
      b.userId
    )
  );
}

function findOpponent(
  current
) {
  let best = null;

  for (
    const [userId, user]
    of waitingQueue
  ) {
    if (
      userId === current.userId
    ) {
      continue;
    }

    if (
      !user.ws ||
      user.ws.readyState !==
        WebSocket.OPEN
    ) {
      waitingQueue.delete(
        userId
      );

      continue;
    }

    if (
      user.emotionHash !==
      current.emotionHash
    ) {
      continue;
    }

    if (
      !mutuallyCompatible(
        current,
        user
      )
    ) {
      continue;
    }

    if (
      !best ||
      user.queuedAt <
        best.queuedAt
    ) {
      best = user;
    }
  }

  return best;
}

function serializeMatchFor(
  userId,
  match
) {
  const isA =
    match.userA.userId ===
    userId;

  const partner =
    isA
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
      profile(
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
    id("match_");

  const createdAt =
    Date.now();

  const expiresAt =
    createdAt +
    MATCH_TIME;

  const pa =
    profile(
      userA.userId
    );

  const pb =
    profile(
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
    chatId:
      chat.id,

    userA: {
      userId:
        userA.userId,
      name:
        pa.name,
      photo:
        userA.photo
    },

    userB: {
      userId:
        userB.userId,
      name:
        pb.name,
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
      () =>
        expireMatch(
          matchId
        ),
      MATCH_TIME
    );
}

function expireMatch(
  matchId
) {
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

  for (
    const uid
    of [
      match.userA.userId,
      match.userB.userId
    ]
  ) {
    userMatches.delete(
      uid
    );

    sendUser(
      uid,
      {
        type:
          "match_expired",

        matchId
      }
    );
  }

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
  m
) {
  if (
    !validHash(
      m.emotionHash
    )
  ) {
    return send(
      ws,
      {
        type: "error",
        message:
          "Invalid emotion"
      }
    );
  }

  if (
    !validPhoto(
      m.photo
    )
  ) {
    return send(
      ws,
      {
        type: "error",
        message:
          "Invalid photo"
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

  const current = {
    userId:
      ws.userId,

    ws,

    emotionHash:
      m.emotionHash,

    photo:
      m.photo,

    queuedAt:
      Date.now(),

    search: {
      gender:
        [
          "male",
          "female",
          "all"
        ].includes(
          m.searchGender
        )
          ? m.searchGender
          : "all",

      ageMin:
        Math.max(
          18,
          Math.min(
            99,
            Number(
              m.ageMin
            ) || 18
          )
        ),

      ageMax:
        Math.max(
          18,
          Math.min(
            99,
            Number(
              m.ageMax
            ) || 99
          )
        )
    }
  };

  if (
    current.search.ageMin >
    current.search.ageMax
  ) {
    [
      current.search.ageMin,
      current.search.ageMax
    ] = [
      current.search.ageMax,
      current.search.ageMin
    ];
  }

  const opponent =
    findOpponent(
      current
    );

  if (!opponent) {
    waitingQueue.set(
      ws.userId,
      current
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
    current
  );
}

function keepVibe(
  ws,
  m
) {
  const match =
    matches.get(
      String(
        m.matchId || ""
      )
    );

  if (!match) {
    return send(
      ws,
      {
        type: "error",
        message:
          "Match expired"
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

  const other =
    users.find(
      x =>
        x !== ws.userId
    );

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
    other,
    {
      type:
        "keep_vibe_received",

      matchId:
        match.matchId
    }
  );

  if (
    match.keep.size === 2
  ) {
    db.makeFriends(
      users[0],
      users[1]
    );

    const chat =
      db.createFriendChat(
        users[0],
        users[1]
      );

    sendUser(
      users[0],
      {
        type:
          "friendship_created",

        friend:
          profile(
            users[1]
          ),

        chatId:
          chat.id
      }
    );

    sendUser(
      users[1],
      {
        type:
          "friendship_created",

        friend:
          profile(
            users[0]
          ),

        chatId:
          chat.id
      }
    );
  }
}

function chatMessage(
  ws,
  m
) {
  const chat =
    db.getChat(
      String(
        m.chatId || ""
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
            "Match chat expired"
        }
      );
    }
  }

  if (
    chat.type ===
    "friend"
  ) {
    const other =
      chat.users.find(
        x =>
          x !== ws.userId
      );

    if (
      !db.areFriends(
        ws.userId,
        other
      )
    ) {
      return;
    }
  }

  const msg =
    db.addMessage(
      chat.id,
      ws.userId,
      m.text
    );

  if (!msg) {
    return;
  }

  chat.users.forEach(
    uid =>
      sendUser(
        uid,
        {
          type:
            "chat_message",

          chatId:
            chat.id,

          message:
            msg
        }
      )
  );
}

wss.on(
  "connection",
  ws => {
    ws.userId =
      id("session_");

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
          const m =
            JSON.parse(
              raw.toString()
            );

          if (
            m.type ===
            "register_profile"
          ) {
            const uid =
              typeof m.userId ===
                "string" &&
              m.userId.length >=
                10 &&
              m.userId.length <=
                120
                ? m.userId
                : id(
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
              uid;

            connected.set(
              uid,
              ws
            );

            const saved =
              db.createOrUpdateUser({
                id: uid,
                name: m.name,
                language:
                  m.language,
                age: m.age,
                gender:
                  m.gender,
                country:
                  m.country,
                avatar:
                  m.avatar
              });

            const activeId =
              userMatches.get(
                uid
              );

            const active =
              activeId
                ? matches.get(
                    activeId
                  )
                : null;

            send(
              ws,
              {
                type:
                  "profile_saved",

                profile:
                  saved
              }
            );

            send(
              ws,
              {
                type:
                  "bootstrap",

                profile:
                  saved,

                friends:
                  db.getFriends(
                    uid
                  ),

                activeMatch:
                  active
                    ? serializeMatchFor(
                        uid,
                        active
                      )
                    : null
              }
            );

            return;
          }

          if (
            m.type ===
            "capture"
          ) {
            return handleCapture(
              ws,
              m
            );
          }

          if (
            m.type ===
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
            m.type ===
            "keep_vibe"
          ) {
            return keepVibe(
              ws,
              m
            );
          }

          if (
            m.type ===
            "end_match"
          ) {
            const mid =
              String(
                m.matchId || ""
              );

            const mt =
              matches.get(
                mid
              );

            if (
              mt &&
              [
                mt.userA.userId,
                mt.userB.userId
              ].includes(
                ws.userId
              )
            ) {
              expireMatch(
                mid
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
            m.type ===
            "chat_message"
          ) {
            return chatMessage(
              ws,
              m
            );
          }

          if (
            m.type ===
            "chat_history"
          ) {
            const chat =
              db.getChat(
                String(
                  m.chatId || ""
                )
              );

            if (
              chat &&
              chat.users.includes(
                ws.userId
              )
            ) {
              return send(
                ws,
                {
                  type:
                    "chat_history",

                  chatId:
                    chat.id,

                  messages:
                    db.getMessages(
                      chat.id
                    )
                }
              );
            }

            return;
          }

          if (
            m.type ===
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
            m.type ===
            "friend_chat_open"
          ) {
            const fid =
              String(
                m.friendId || ""
              );

            if (
              db.areFriends(
                ws.userId,
                fid
              )
            ) {
              const chat =
                db.createFriendChat(
                  ws.userId,
                  fid
                );

              return send(
                ws,
                {
                  type:
                    "friend_chat_ready",

                  chatId:
                    chat.id,

                  friend:
                    profile(
                      fid
                    ),

                  messages:
                    db.getMessages(
                      chat.id
                    )
                }
              );
            }

            return;
          }

          if (
            m.type ===
            "report_user"
          ) {
            db.reportUser(
              ws.userId,
              String(
                m.targetUserId ||
                  ""
              ),
              m.reason
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
            m.type ===
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
        } catch (e) {
          console.error(
            e
          );

          send(
            ws,
            {
              type:
                "error",

              message:
                "Bad request"
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
      const [uid, u]
      of waitingQueue
    ) {
      if (
        !u.ws ||
        u.ws.readyState !==
          WebSocket.OPEN
      ) {
        waitingQueue.delete(
          uid
        );
      }
    }

    for (
      const [mid, m]
      of matches
    ) {
      if (
        Date.now() >=
        m.expiresAt
      ) {
        expireMatch(
          mid
        );
      }
    }
  },
  60000
);

server.listen(
  PORT,
  () =>
    console.log(
      `SnapVibe 3.3 running on port ${PORT}`
    )
);
