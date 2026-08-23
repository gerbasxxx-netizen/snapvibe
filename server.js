"use strict";

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const db = require("./db");
const webpush = require("web-push");

const PORT = process.env.PORT || 3000;
const MATCH_TIME = 24 * 60 * 60 * 1000;
const MAX_PHOTO = 6 * 1024 * 1024;
const MAX_VOICE = 8 * 1024 * 1024;

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || "";

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || "";

const VAPID_SUBJECT =
  process.env.VAPID_SUBJECT ||
  "mailto:admin@snapvibe.app";

if (
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
      "VAPID setup error:",
      error
    );
  }
}

const app = express();
const server = http.createServer(app);

const wss =
  new WebSocket.Server({
    server,
    maxPayload:
      12 * 1024 * 1024
  });


/* =========================================================
   ACTIVE / REALTIME STATE
   Это можно держать в памяти:
   ожидание поиска, активные соединения и текущие мэтчи
========================================================= */

const waitingQueue =
  new Map();

const matches =
  new Map();

const userMatches =
  new Map();

const connected =
  new Map();

const profileCache =
  new Map();


/* =========================================================
   STATIC SITE
========================================================= */

app.use(
  express.static(__dirname)
);


/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/health",
  async (req, res) => {
    let users = null;
    let database = false;

    try {
      database =
        await db.ping();

      users =
        await db.countUsers();
    } catch (error) {
      console.error(
        "Health DB error:",
        error.message
      );
    }

    res.json({
      ok: true,
      service:
        "SnapVibe 5.0",
      database,
      users,
      waiting:
        waitingQueue.size,
      matches:
        matches.size,
      connected:
        connected.size,
      pushConfigured:
        Boolean(
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


/* =========================================================
   HELPERS
========================================================= */

function makeId(prefix = "") {
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
      "WebSocket send error:",
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


function normalizeCountry(
  value
) {
  return String(value || "")
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


function fallbackProfile(
  userId
) {
  return {
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
  };
}


async function getProfile(
  userId,
  force = false
) {
  if (
    !force &&
    profileCache.has(userId)
  ) {
    return profileCache.get(
      userId
    );
  }

  try {
    const profile =
      await db.publicUser(
        userId
      );

    if (profile) {
      profileCache.set(
        userId,
        profile
      );

      return profile;
    }
  } catch (error) {
    console.error(
      "Profile error:",
      error.message
    );
  }

  return fallbackProfile(
    userId
  );
}


/* =========================================================
   SEARCH FILTERS
========================================================= */

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


async function mutuallyCompatible(
  a,
  b
) {
  if (
    !prefAllows(
      a.search,
      b.profile
    )
  ) {
    return false;
  }

  if (
    !prefAllows(
      b.search,
      a.profile
    )
  ) {
    return false;
  }

  try {
    const blocked =
      await db
        .isBlockedEitherWay(
          a.userId,
          b.userId
        );

    if (blocked) {
      return false;
    }
  } catch (error) {
    console.error(
      "Block check error:",
      error.message
    );

    return false;
  }

  return true;
}


async function findOpponent(
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
      !await mutuallyCompatible(
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


/* =========================================================
   MATCH
========================================================= */

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
      partner.profile.name,

    partnerProfile:
      partner.profile,

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


async function createMatch(
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

  const chat =
    await db.createMatchChat(
      matchId,
      a.userId,
      b.userId
    );

  if (!chat) {
    throw new Error(
      "Не удалось создать чат мэтча"
    );
  }

  const match = {
    matchId,
    createdAt,
    expiresAt,

    chatId:
      chat.id,

    userA: {
      userId:
        a.userId,
      profile:
        a.profile,
      photo:
        a.photo
    },

    userB: {
      userId:
        b.userId,
      profile:
        b.profile,
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
        ).catch(
          console.error
        );
      },
      MATCH_TIME
    );
}


async function finishMatch(
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

  try {
    await db.deleteChat(
      match.chatId
    );
  } catch (error) {
    console.error(
      "Delete match chat:",
      error.message
    );
  }

  match.userA.photo =
    null;

  match.userB.photo =
    null;

  matches.delete(
    matchId
  );
}


/* =========================================================
   CAPTURE / SEARCH
========================================================= */

async function handleCapture(
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
        type:"error",
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
        type:"error",
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
        type:"error",
        message:
          "У вас уже есть активный мэтч."
      }
    );
  }

  waitingQueue.delete(
    ws.userId
  );

  const profile =
    await getProfile(
      ws.userId,
      true
    );

  const current = {
    userId:
      ws.userId,

    ws,

    profile,

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
    await findOpponent(
      current
    );

  if (
    !opponent ||
    !waitingQueue.has(
      opponent.userId
    )
  ) {
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

  await createMatch(
    opponent,
    current
  );
}


/* =========================================================
   KEEP THE VIBE
========================================================= */

async function keepVibe(
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
        type:"error",
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
    await getProfile(
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

        already:true
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
    match.keep.size !== 2
  ) {
    return;
  }

  await db.makeFriends(
    users[0],
    users[1]
  );

  const permanentChat =
    await db.createFriendChat(
      users[0],
      users[1]
    );

  for (
    const userId
    of users
  ) {
    const friendId =
      users.find(
        id =>
          id !== userId
      );

    const friend =
      await getProfile(
        friendId,
        true
      );

    sendUser(
      userId,
      {
        type:
          "keep_vibe_mutual",

        matchId:
          match.matchId,

        friend,

        chatId:
          permanentChat.id
      }
    );

    sendUser(
      userId,
      {
        type:
          "friendship_created",

        friend,

        chatId:
          permanentChat.id
      }
    );
  }
}


/* =========================================================
   MESSAGE FORMAT
========================================================= */

async function enrichMessage(
  message
) {
  if (!message) {
    return null;
  }

  const sender =
    await getProfile(
      message.senderId
    );

  return {
    ...message,

    senderName:
      sender.name,

    senderAvatar:
      sender.avatar,

    senderGender:
      sender.gender ||
      "other",

    deliveredTo:
      message.deliveredTo ||
      [],

    readBy:
      message.readBy ||
      []
  };
}


/* =========================================================
   PUSH
========================================================= */

async function sendPush(
  userId,
  payload
) {
  if (
    !VAPID_PUBLIC_KEY ||
    !VAPID_PRIVATE_KEY
  ) {
    return;
  }

  let subscriptions = [];

  try {
    subscriptions =
      await db
        .getPushSubscriptions(
          userId
        );
  } catch (error) {
    console.error(
      "Load push subscriptions:",
      error.message
    );

    return;
  }

  for (
    const item
    of subscriptions
  ) {
    try {
      await webpush
        .sendNotification(
          item.subscription,
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
        try {
          await db
            .deletePushSubscription(
              item.endpoint
            );
        } catch (_) {}
      }
    }
  }
}


async function sendMessageNotification(
  chat,
  senderId,
  savedMessage
) {
  const sender =
    await getProfile(
      senderId
    );

  const receivers =
    chat.users.filter(
      userId =>
        userId !==
        senderId
    );

  for (
    const userId
    of receivers
  ) {
    await sendPush(
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
}


/* =========================================================
   TEXT MESSAGE
========================================================= */

async function handleTextMessage(
  ws,
  message
) {
  const chat =
    await db.getChat(
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
          type:"error",
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
      !await db.areFriends(
        ws.userId,
        other
      )
    ) {
      return;
    }
  }

  const savedMessage =
    await db.addRichMessage(
      chat.id,
      ws.userId,
      {
        type:"text",
        text:
          message.text
      }
    );

  if (!savedMessage) {
    return;
  }

  const fullMessage =
    await enrichMessage(
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
  ).catch(
    console.error
  );
}


/* =========================================================
   VOICE MESSAGE
========================================================= */

async function handleVoiceMessage(
  ws,
  message
) {
  const chat =
    await db.getChat(
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
        type:"error",
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

  const savedMessage =
    await db.addRichMessage(
      chat.id,
      ws.userId,
      {
        type:"voice",
        audio:
          message.audio,
        duration
      }
    );

  if (!savedMessage) {
    return;
  }

  const fullMessage =
    await enrichMessage(
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
  ).catch(
    console.error
  );
}


/* =========================================================
   DELIVERED / READ
========================================================= */

async function markDelivered(
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
    await db.getChat(
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

  const updated =
    await db.markDelivered(
      chatId,
      messageId,
      ws.userId
    );

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


async function markRead(
  ws,
  message
) {
  const chatId =
    String(
      message.chatId ||
      ""
    );

  const chat =
    await db.getChat(
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

  const updatedIds =
    await db.markChatRead(
      chatId,
      ws.userId
    );

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


/* =========================================================
   CALLS
========================================================= */

async function validCallTarget(
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

  return await db.areFriends(
    fromUserId,
    targetUserId
  );
}


async function handleCallInvite(
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
    !await validCallTarget(
      ws.userId,
      targetUserId
    )
  ) {
    return send(
      ws,
      {
        type:"call_error",
        message:
          "Звонок недоступен"
      }
    );
  }

  const caller =
    await getProfile(
      ws.userId
    );

  const callId =
    makeId("call_");

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
  ).catch(
    console.error
  );
}


async function relayCallEvent(
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
    !await validCallTarget(
      ws.userId,
      targetUserId
    )
  ) {
    return;
  }

  const sender =
    await getProfile(
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


/* =========================================================
   PUSH SUBSCRIBE
========================================================= */

async function savePushSubscription(
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

  await db
    .savePushSubscription(
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


/* =========================================================
   PROFILE REGISTER
========================================================= */

async function registerUser(
  ws,
  message
) {
  const userId =
    typeof message.userId ===
      "string" &&
    message.userId.length >=
      10 &&
    message.userId.length <=
      120

      ? message.userId
      : makeId("user_");

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
    await db.createOrUpdateUser({
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

  profileCache.set(
    userId,
    saved
  );

  const friends =
    await db.getFriends(
      userId
    );

  friends.forEach(
    friend => {
      profileCache.set(
        friend.id,
        friend
      );
    }
  );

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

      friends,

      activeMatch:
        activeMatch
          ? serializeMatch(
              userId,
              activeMatch
            )
          : null
    }
  );
}


/* =========================================================
   FRIEND CHAT
========================================================= */

async function openFriendChat(
  ws,
  friendId
) {
  if (
    !await db.areFriends(
      ws.userId,
      friendId
    )
  ) {
    return;
  }

  const chat =
    await db.createFriendChat(
      ws.userId,
      friendId
    );

  const messages =
    await db.getMessages(
      chat.id
    );

  const history = [];

  for (
    const message
    of messages
  ) {
    history.push(
      await enrichMessage(
        message
      )
    );
  }

  const friend =
    await getProfile(
      friendId,
      true
    );

  send(
    ws,
    {
      type:
        "friend_chat_ready",

      chatId:
        chat.id,

      friend,

      messages:
        history
    }
  );
}


/* =========================================================
   CHAT HISTORY
========================================================= */

async function sendChatHistory(
  ws,
  chatId
) {
  const chat =
    await db.getChat(
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

  const messages =
    await db.getMessages(
      chat.id
    );

  const history = [];

  for (
    const message
    of messages
  ) {
    history.push(
      await enrichMessage(
        message
      )
    );
  }

  send(
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


/* =========================================================
   FRIEND LIST
========================================================= */

async function sendFriendsList(
  ws
) {
  const friends =
    await db.getFriends(
      ws.userId
    );

  friends.forEach(
    friend => {
      profileCache.set(
        friend.id,
        friend
      );
    }
  );

  send(
    ws,
    {
      type:
        "friends_list",

      friends
    }
  );
}


/* =========================================================
   WEBSOCKET CONNECTION
========================================================= */

wss.on(
  "connection",
  ws => {
    ws.userId =
      makeId("session_");

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
      async raw => {
        try {
          const message =
            JSON.parse(
              raw.toString()
            );

          switch (
            message.type
          ) {
            case "register_profile":
              await registerUser(
                ws,
                message
              );
              break;


            case "capture":
              await handleCapture(
                ws,
                message
              );
              break;


            case "cancel_search":
              waitingQueue.delete(
                ws.userId
              );

              send(
                ws,
                {
                  type:
                    "search_cancelled"
                }
              );
              break;


            case "keep_vibe":
              await keepVibe(
                ws,
                message
              );
              break;


            case "end_match":
            case "next_match": {
              const matchId =
                String(
                  message.matchId ||
                  userMatches.get(
                    ws.userId
                  ) ||
                  ""
                );

              await finishMatch(
                matchId,
                "next_match",
                ws.userId
              );

              break;
            }


            case "chat_message":
              await handleTextMessage(
                ws,
                message
              );
              break;


            case "voice_message":
              await handleVoiceMessage(
                ws,
                message
              );
              break;


            case "message_delivered":
              await markDelivered(
                ws,
                message
              );
              break;


            case "chat_read":
              await markRead(
                ws,
                message
              );
              break;


            case "chat_history":
              await sendChatHistory(
                ws,
                String(
                  message.chatId ||
                  ""
                )
              );
              break;


            case "friends_list":
              await sendFriendsList(
                ws
              );
              break;


            case "friend_chat_open":
              await openFriendChat(
                ws,
                String(
                  message.friendId ||
                  ""
                )
              );
              break;


            case "push_subscribe":
              await savePushSubscription(
                ws,
                message
              );
              break;


            case "call_invite":
              await handleCallInvite(
                ws,
                message
              );
              break;


            case "call_accept":
              await relayCallEvent(
                ws,
                message,
                "call_accepted"
              );
              break;


            case "call_reject":
              await relayCallEvent(
                ws,
                message,
                "call_rejected"
              );
              break;


            case "call_end":
              await relayCallEvent(
                ws,
                message,
                "call_ended"
              );
              break;


            case "webrtc_offer":
              await relayCallEvent(
                ws,
                message,
                "webrtc_offer"
              );
              break;


            case "webrtc_answer":
              await relayCallEvent(
                ws,
                message,
                "webrtc_answer"
              );
              break;


            case "webrtc_ice":
              await relayCallEvent(
                ws,
                message,
                "webrtc_ice"
              );
              break;


            case "report_user":
              await db.reportUser(
                ws.userId,
                String(
                  message.targetUserId ||
                  ""
                ),
                message.reason
              );

              send(
                ws,
                {
                  type:
                    "report_received"
                }
              );
              break;


            case "ping":
              send(
                ws,
                {
                  type:"pong",
                  time:
                    Date.now()
                }
              );
              break;
          }

        } catch (error) {
          console.error(
            "Message error:",
            error
          );

          send(
            ws,
            {
              type:"error",

              message:
                "Ошибка сервера"
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


/* =========================================================
   CLEANUP
========================================================= */

setInterval(
  async () => {
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
        try {
          await finishMatch(
            matchId,
            "expired"
          );
        } catch (error) {
          console.error(
            "Match cleanup:",
            error.message
          );
        }
      }
    }
  },
  60000
);


/* =========================================================
   START SERVER
========================================================= */

server.listen(
  PORT,
  async () => {
    console.log(
      `SnapVibe 5.0 running on port ${PORT}`
    );

    console.log(
      "Supabase configured:",
      db.configured()
    );

    try {
      await db.ping();

      console.log(
        "Supabase connection: OK"
      );
    } catch (error) {
      console.error(
        "Supabase connection FAILED:",
        error.message
      );
    }
  }
);
