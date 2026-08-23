const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const db = require("./db");

let webpush = null;

try {
  webpush = require("web-push");
} catch (error) {
  console.log(
    "web-push пока не установлен"
  );
}

const PORT =
  process.env.PORT || 3000;

const MATCH_TIME =
  24 * 60 * 60 * 1000;

const MAX_PHOTO =
  6 * 1024 * 1024;

const MAX_VOICE =
  8 * 1024 * 1024;

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@snapvibe.app";

if (
  webpush &&
  VAPID_PUBLIC_KEY &&
  VAPID_PRIVATE_KEY
) {
  try {
    webpush.setVapidDetails(
      VAPID_SUBJECT,
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
  } catch (error) {
    console.error(
      "VAPID error:",
      error
    );
  }
}

const app =
  express();

const server =
  http.createServer(app);

const wss =
  new WebSocket.Server({
    server,
    maxPayload:
      12 * 1024 * 1024
  });

const waitingQueue =
  new Map();

const matches =
  new Map();

const userMatches =
  new Map();

const connected =
  new Map();

const pushSubscriptions =
  new Map();

app.use(
  express.static(__dirname)
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "SnapVibe 4.0",
      waiting:
        waitingQueue.size,
      matches:
        matches.size,
      connected:
        connected.size,
      users:
        db.users?.size || 0,
      pushConfigured:
        Boolean(
          webpush &&
          VAPID_PUBLIC_KEY &&
          VAPID_PRIVATE_KEY
        ),
      time:
        new Date()
          .toISOString()
    });
  }
);

app.get(
  "/push-public-key",
  (req, res) => {
    res.json({
      publicKey:
        VAPID_PUBLIC_KEY
    });
  }
);

function makeId(prefix) {
  return (
    prefix +
    crypto.randomUUID()
  );
}

function send(ws, data) {
  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return false;
  }

  try {
    ws.send(
      JSON.stringify(data)
    );

    return true;
  } catch (error) {
    console.error(
      "Send error:",
      error
    );

    return false;
  }
}

function sendUser(
  userId,
  data
) {
  return send(
    connected.get(userId),
    data
  );
}

function profile(userId) {
  return (
    db.publicUser(userId) || {
      id: userId,
      name:
        "SnapVibe User",
      age: null,
      gender:
        "other",
      country: "",
      language:
        "ru",
      avatar: ""
    }
  );
}

function normalizeCountry(
  value
) {
  return String(
    value || ""
  )
    .trim()
    .toUpperCase();
}

function validHash(value) {
  return (
    typeof value ===
      "string" &&
    /^[a-f0-9]{64}$/i
      .test(value)
  );
}

function validPhoto(value) {
  return (
    typeof value ===
      "string" &&
    value.startsWith(
      "data:image/"
    ) &&
    Buffer.byteLength(
      value,
      "utf8"
    ) <= MAX_PHOTO
  );
}

function validVoice(value) {
  if (
    typeof value !==
    "string"
  ) {
    return false;
  }

  const validType =
    value.startsWith(
      "data:audio/"
    ) ||
    value.startsWith(
      "data:application/octet-stream"
    );

  return (
    validType &&
    Buffer.byteLength(
      value,
      "utf8"
    ) <= MAX_VOICE
  );
}

function prefAllows(
  pref,
  candidate
) {
  const wantedGender =
    pref?.gender || "all";

  if (
    wantedGender !== "all" &&
    candidate.gender !==
      wantedGender
  ) {
    return false;
  }

  const min =
    Number(
      pref?.ageMin || 18
    );

  const max =
    Number(
      pref?.ageMax || 99
    );

  const age =
    Number(
      candidate.age || 0
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

  const wantedCountry =
    normalizeCountry(
      pref?.country
    );

  const candidateCountry =
    normalizeCountry(
      candidate.country
    );

  if (
    wantedCountry &&
    wantedCountry !==
      "ALL" &&
    candidateCountry !==
      wantedCountry
  ) {
    return false;
  }

  return true;
}

function mutuallyCompatible(
  a,
  b
) {
  return (
    prefAllows(
      a.search,
      profile(b.userId)
    ) &&
    prefAllows(
      b.search,
      profile(a.userId)
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
    const [userId, item]
    of waitingQueue
  ) {
    if (
      userId ===
      current.userId
    ) {
      continue;
    }

    if (
      !item.ws ||
      item.ws.readyState !==
        WebSocket.OPEN
    ) {
      waitingQueue.delete(
        userId
      );

      continue;
    }

    if (
      item.emotionHash !==
      current.emotionHash
    ) {
      continue;
    }

    if (
      !mutuallyCompatible(
        current,
        item
      )
    ) {
      continue;
    }

    if (
      !best ||
      item.queuedAt <
        best.queuedAt
    ) {
      best = item;
    }
  }

  return best;
}

function serializeMatch(
  userId,
  match
) {
  const mineIsA =
    match.userA.userId ===
    userId;

  const partner =
    mineIsA
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
  a,
  b
) {
  const matchId =
    makeId("match_");

  const createdAt =
    Date.now();

  const expiresAt =
    createdAt +
    MATCH_TIME;

  const profileA =
    profile(a.userId);

  const profileB =
    profile(b.userId);

  const chat =
    db.createMatchChat(
      matchId,
      a.userId,
      b.userId
    );

  const match = {
    matchId,
    createdAt,
    expiresAt,
    chatId:
      chat.id,

    userA: {
      userId:
        a.userId,
      name:
        profileA.name,
      photo:
        a.photo
    },

    userB: {
      userId:
        b.userId,
      name:
        profileB.name,
      photo:
        b.photo
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
    a.userId,
    matchId
  );

  userMatches.set(
    b.userId,
    matchId
  );

  waitingQueue.delete(
    a.userId
  );

  waitingQueue.delete(
    b.userId
  );

  send(
    a.ws,
    {
      type:
        "match_found",
      ...serializeMatch(
        a.userId,
        match
      )
    }
  );

  send(
    b.ws,
    {
      type:
        "match_found",
      ...serializeMatch(
        b.userId,
        match
      )
    }
  );

  match.timer =
    setTimeout(
      () => {
        finishMatch(
          matchId,
          "expired"
        );
      },
      MATCH_TIME
    );
}

function finishMatch(
  matchId,
  reason = "ended",
  initiator = null
) {
  const match =
    matches.get(matchId);

  if (!match) {
    if (initiator) {
      userMatches.delete(
        initiator
      );

      sendUser(
        initiator,
        {
          type:
            "match_ended",
          matchId,
          reason
        }
      );
    }

    return;
  }

  if (match.timer) {
    clearTimeout(
      match.timer
    );
  }

  const users = [
    match.userA.userId,
    match.userB.userId
  ];

  users.forEach(
    userId => {
      userMatches.delete(
        userId
      );
    }
  );

  if (
    reason ===
      "next_match" ||
    reason ===
      "ended"
  ) {
    users.forEach(
      userId => {
        sendUser(
          userId,
          {
            type:
              userId ===
              initiator
                ? "match_ended"
                : "match_ended_by_partner",

            matchId,
            reason
          }
        );
      }
    );
  } else {
    users.forEach(
      userId => {
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
        type:
          "error",
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
        type:
          "error",
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
        type:
          "error",
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
        normalizeCountry(
          message.searchCountry
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
        type:
          "error",
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

  const other =
    users.find(
      userId =>
        userId !==
        ws.userId
    );

  const sender =
    profile(
      ws.userId
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
    other,
    {
      type:
        "keep_vibe_received",
      matchId:
        match.matchId,
      fromUserId:
        ws.userId,
      fromName:
        sender.name,
      fromAvatar:
        sender.avatar
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

    users.forEach(
      userId => {
        const friendId =
          users.find(
            id =>
              id !== userId
          );

        sendUser(
          userId,
          {
            type:
              "keep_vibe_mutual",
            matchId:
              match.matchId,
            friend:
              profile(
                friendId
              ),
            chatId:
              permanentChat.id
          }
        );

        sendUser(
          userId,
          {
            type:
              "friendship_created",
            friend:
              profile(
                friendId
              ),
            chatId:
              permanentChat.id
          }
        );
      }
    );
  }
}
function enrichMessage(message) {
  if (!message) {
    return null;
  }

  const sender =
    profile(
      message.senderId
    );

  return {
    ...message,

    senderName:
      sender.name,

    senderAvatar:
      sender.avatar,

    senderGender:
      sender.gender || "other",

    deliveredTo:
      message.deliveredTo || [],

    readBy:
      message.readBy || []
  };
}


async function sendPush(
  userId,
  payload
) {
  if (
    !webpush ||
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    return;
  }

  const subscription =
    pushSubscriptions.get(
      userId
    );

  if (!subscription) {
    return;
  }

  try {
    await webpush
      .sendNotification(
        subscription,
        JSON.stringify(
          payload
        )
      );
  } catch (error) {
    console.error(
      "Push error:",
      error.statusCode ||
      error.message
    );

    if (
      error.statusCode === 404 ||
      error.statusCode === 410
    ) {
      pushSubscriptions.delete(
        userId
      );
    }
  }
}


function sendMessageNotification(
  chat,
  senderId,
  savedMessage
) {
  const sender =
    profile(senderId);

  chat.users
    .filter(
      userId =>
        userId !== senderId
    )
    .forEach(
      userId => {

        sendPush(
          userId,
          {
            type:
              "chat_message",

            title:
              sender.name,

            body:
              savedMessage.type ===
              "voice"
                ? "🎤 Голосовое сообщение"
                : savedMessage.text,

            chatId:
              chat.id,

            senderId,

            icon:
              sender.avatar || "",

            url:
              "/preview3.html?chat=" +
              encodeURIComponent(
                chat.id
              )
          }
        );

      }
    );
}


function handleTextMessage(
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
    const activeMatch =
      matches.get(
        chat.matchId
      );

    if (
      !activeMatch ||
      Date.now() >=
        activeMatch.expiresAt
    ) {
      return send(
        ws,
        {
          type:
            "error",

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
    const other =
      chat.users.find(
        userId =>
          userId !==
          ws.userId
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


  let savedMessage = null;


  if (
    typeof db.addRichMessage ===
    "function"
  ) {
    savedMessage =
      db.addRichMessage(
        chat.id,
        ws.userId,
        {
          type:
            "text",

          text:
            message.text
        }
      );
  } else {
    savedMessage =
      db.addMessage(
        chat.id,
        ws.userId,
        message.text
      );
  }


  if (!savedMessage) {
    return;
  }


  const fullMessage =
    enrichMessage(
      savedMessage
    );


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


  sendMessageNotification(
    chat,
    ws.userId,
    fullMessage
  );
}


function handleVoiceMessage(
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
    !validVoice(
      message.audio
    )
  ) {
    return send(
      ws,
      {
        type:
          "error",

        message:
          "Не удалось отправить голосовое сообщение"
      }
    );
  }


  const duration =
    Math.max(
      1,
      Math.min(
        600,
        Number(
          message.duration
        ) || 1
      )
    );


  let savedMessage = null;


  if (
    typeof db.addRichMessage ===
    "function"
  ) {
    savedMessage =
      db.addRichMessage(
        chat.id,
        ws.userId,
        {
          type:
            "voice",

          audio:
            message.audio,

          duration
        }
      );
  } else {
    return send(
      ws,
      {
        type:
          "error",

        message:
          "Голосовые сообщения требуют обновления базы"
      }
    );
  }


  if (!savedMessage) {
    return;
  }


  const fullMessage =
    enrichMessage(
      savedMessage
    );


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


  sendMessageNotification(
    chat,
    ws.userId,
    fullMessage
  );
}


function markDelivered(
  ws,
  message
) {
  const chatId =
    String(
      message.chatId ||
      ""
    );

  const messageId =
    String(
      message.messageId ||
      ""
    );


  const chat =
    db.getChat(
      chatId
    );


  if (
    !chat ||
    !chat.users.includes(
      ws.userId
    )
  ) {
    return;
  }


  let updated = null;


  if (
    typeof db.markDelivered ===
    "function"
  ) {
    updated =
      db.markDelivered(
        chatId,
        messageId,
        ws.userId
      );
  }


  if (!updated) {
    return;
  }


  chat.users.forEach(
    userId => {

      sendUser(
        userId,
        {
          type:
            "message_delivered",

          chatId,

          messageId,

          userId:
            ws.userId
        }
      );

    }
  );
}


function markRead(
  ws,
  message
) {
  const chatId =
    String(
      message.chatId ||
      ""
    );


  const chat =
    db.getChat(
      chatId
    );


  if (
    !chat ||
    !chat.users.includes(
      ws.userId
    )
  ) {
    return;
  }


  let updatedIds = [];


  if (
    typeof db.markChatRead ===
    "function"
  ) {
    updatedIds =
      db.markChatRead(
        chatId,
        ws.userId
      ) || [];
  }


  if (
    !updatedIds.length
  ) {
    return;
  }


  chat.users.forEach(
    userId => {

      sendUser(
        userId,
        {
          type:
            "messages_read",

          chatId,

          messageIds:
            updatedIds,

          userId:
            ws.userId
        }
      );

    }
  );
}


function validCallTarget(
  fromUserId,
  targetUserId
) {
  if (
    !targetUserId ||
    targetUserId ===
      fromUserId
  ) {
    return false;
  }


  const matchId =
    userMatches.get(
      fromUserId
    );


  if (matchId) {
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
        targetUserId
      )
    ) {
      return true;
    }
  }


  return db.areFriends(
    fromUserId,
    targetUserId
  );
}


function handleCallInvite(
  ws,
  message
) {
  const targetUserId =
    String(
      message.targetUserId ||
      ""
    );


  const callType =
    message.callType ===
    "video"
      ? "video"
      : "audio";


  if (
    !validCallTarget(
      ws.userId,
      targetUserId
    )
  ) {
    return send(
      ws,
      {
        type:
          "call_error",

        message:
          "Звонок недоступен"
      }
    );
  }


  const caller =
    profile(
      ws.userId
    );


  const callId =
    makeId(
      "call_"
    );


  sendUser(
    targetUserId,
    {
      type:
        "incoming_call",

      callId,

      callType,

      fromUserId:
        ws.userId,

      fromName:
        caller.name,

      fromAvatar:
        caller.avatar
    }
  );


  send(
    ws,
    {
      type:
        "call_ringing",

      callId,

      callType,

      targetUserId
    }
  );


  sendPush(
    targetUserId,
    {
      type:
        "incoming_call",

      title:
        caller.name,

      body:
        callType ===
        "video"
          ? "📹 Видеозвонок"
          : "📞 Аудиозвонок",

      callId,

      callType,

      fromUserId:
        ws.userId,

      url:
        "/preview3.html"
    }
  );
}


function relayCallEvent(
  ws,
  message,
  eventType
) {
  const targetUserId =
    String(
      message.targetUserId ||
      ""
    );


  if (
    !validCallTarget(
      ws.userId,
      targetUserId
    )
  ) {
    return;
  }


  const sender =
    profile(
      ws.userId
    );


  sendUser(
    targetUserId,
    {
      type:
        eventType,

      callId:
        message.callId,

      fromUserId:
        ws.userId,

      fromName:
        sender.name,

      fromAvatar:
        sender.avatar,

      callType:
        message.callType,

      sdp:
        message.sdp,

      candidate:
        message.candidate
    }
  );
}


function savePushSubscription(
  ws,
  message
) {
  const subscription =
    message.subscription;


  if (
    !subscription ||
    typeof subscription !==
      "object"
  ) {
    return;
  }


  pushSubscriptions.set(
    ws.userId,
    subscription
  );


  send(
    ws,
    {
      type:
        "push_subscription_saved"
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


            const saved =
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


            const activeId =
              userMatches.get(
                userId
              );


            const activeMatch =
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
                    userId
                  ),

                activeMatch:
                  activeMatch
                    ? serializeMatch(
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
            "end_match" ||
            message.type ===
            "next_match"
          ) {

            const matchId =
              String(
                message.matchId ||
                userMatches.get(
                  ws.userId
                ) ||
                ""
              );


            finishMatch(
              matchId,
              "next_match",
              ws.userId
            );


            return;
          }


          if (
            message.type ===
            "chat_message"
          ) {
            return handleTextMessage(
              ws,
              message
            );
          }


          if (
            message.type ===
            "voice_message"
          ) {
            return handleVoiceMessage(
              ws,
              message
            );
          }


          if (
            message.type ===
            "message_delivered"
          ) {
            return markDelivered(
              ws,
              message
            );
          }


          if (
            message.type ===
            "chat_read"
          ) {
            return markRead(
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
                )
                .map(
                  enrichMessage
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
                )
                .map(
                  enrichMessage
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
            "push_subscribe"
          ) {
            return savePushSubscription(
              ws,
              message
            );
          }


          if (
            message.type ===
            "call_invite"
          ) {
            return handleCallInvite(
              ws,
              message
            );
          }


          if (
            message.type ===
            "call_accept"
          ) {
            return relayCallEvent(
              ws,
              message,
              "call_accepted"
            );
          }


          if (
            message.type ===
            "call_reject"
          ) {
            return relayCallEvent(
              ws,
              message,
              "call_rejected"
            );
          }


          if (
            message.type ===
            "call_end"
          ) {
            return relayCallEvent(
              ws,
              message,
              "call_ended"
            );
          }


          if (
            message.type ===
            "webrtc_offer"
          ) {
            return relayCallEvent(
              ws,
              message,
              "webrtc_offer"
            );
          }


          if (
            message.type ===
            "webrtc_answer"
          ) {
            return relayCallEvent(
              ws,
              message,
              "webrtc_answer"
            );
          }


          if (
            message.type ===
            "webrtc_ice"
          ) {
            return relayCallEvent(
              ws,
              message,
              "webrtc_ice"
            );
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
            "Message error:",
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
      const [userId, item]
      of waitingQueue
    ) {

      if (
        !item.ws ||
        item.ws.readyState !==
          WebSocket.OPEN
      ) {

        waitingQueue.delete(
          userId
        );

      }

    }


    for (
      const [matchId, item]
      of matches
    ) {

      if (
        Date.now() >=
        item.expiresAt
      ) {

        finishMatch(
          matchId,
          "expired"
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
      `SnapVibe 4.0 running on port ${PORT}`
    );

  }
);
