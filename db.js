"use strict";

const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || "");

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

function requireConfig() {
  if (!configured()) {
    throw new Error("Supabase is not configured: SUPABASE_URL / SUPABASE_SECRET_KEY");
  }
}

function cleanText(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeAvatar(value) {
  const avatar = String(value || "");

  if (
    avatar.startsWith("data:image/") &&
    Buffer.byteLength(avatar, "utf8") <= 5 * 1024 * 1024
  ) {
    return avatar;
  }

  if (/^https:\/\//i.test(avatar) && avatar.length <= 2048) {
    return avatar;
  }

  return "";
}

function safeAudio(value) {
  const audio = String(value || "");

  const validType =
    audio.startsWith("data:audio/") ||
    audio.startsWith("data:application/octet-stream") ||
    /^https:\/\//i.test(audio);

  if (
    validType &&
    Buffer.byteLength(audio, "utf8") <= 8 * 1024 * 1024
  ) {
    return audio;
  }

  return "";
}

function headers(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function request(path, options = {}) {
  requireConfig();

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,
      headers: headers(options.headers || {})
    }
  );

  if (!response.ok) {
    const body =
      await response.text().catch(() => "");

    throw new Error(
      `Supabase ${response.status}: ${body || response.statusText}`
    );
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  return text ? JSON.parse(text) : null;
}

function eq(value) {
  return encodeURIComponent(String(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function rowToUser(row) {
  if (!row) return null;

  return {
    id: row.user_id,
    name: row.name,
    language: row.language || "ru",
    age: row.age,
    gender: row.gender || "other",
    country: row.country || "",
    avatar: row.avatar || "",
    createdAt:
      row.created_at
        ? Date.parse(row.created_at)
        : Date.now(),
    updatedAt:
      row.updated_at
        ? Date.parse(row.updated_at)
        : Date.now()
  };
}

function rowToChat(row) {
  if (!row) return null;

  return {
    id: row.id,
    users: [
      row.user_a,
      row.user_b
    ].filter(Boolean),

    type: row.type,
    matchId: row.match_id || null,

    createdAt:
      row.created_at
        ? Date.parse(row.created_at)
        : Date.now()
  };
}

function rowToMessage(row) {
  if (!row) return null;

  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    type: row.type || "text",
    text: row.text || undefined,
    audio: row.audio || undefined,
    duration: row.duration || undefined,

    createdAt:
      row.created_at
        ? Date.parse(row.created_at)
        : Date.now(),

    deliveredTo:
      asArray(row.delivered_to),

    readBy:
      asArray(row.read_by)
  };
}

async function ping() {
  requireConfig();

  await request(
    "profiles?select=user_id&limit=1",
    {
      method: "GET"
    }
  );

  return true;
}

async function countUsers() {
  requireConfig();

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?select=user_id`,
    {
      method: "HEAD",

      headers: headers({
        Prefer: "count=exact"
      })
    }
  );

  if (!response.ok) {
    return null;
  }

  const range =
    response.headers.get("content-range") || "";

  const total =
    Number(range.split("/")[1]);

  return Number.isFinite(total)
    ? total
    : null;
}


/* =========================
   USERS
========================= */

async function getUser(userId) {
  const rows =
    await request(
      `profiles?user_id=eq.${eq(userId)}&select=*&limit=1`,
      {
        method: "GET"
      }
    );

  return rowToUser(rows?.[0]);
}

async function createOrUpdateUser(input) {
  if (!input?.id) {
    throw new Error("User ID required");
  }

  const oldUser =
    (await getUser(input.id)) || {};

  const ageRaw =
    input.age !== undefined &&
    input.age !== null &&
    input.age !== ""
      ? Number(input.age)
      : oldUser.age;

  const user = {
    id: input.id,

    name:
      cleanText(
        input.name ||
        oldUser.name ||
        "SnapVibe User",
        30
      ),

    language:
      cleanText(
        input.language ||
        oldUser.language ||
        "ru",
        8
      ),

    age:
      ageRaw
        ? Math.max(
            18,
            Math.min(
              99,
              ageRaw
            )
          )
        : null,

    gender:
      [
        "male",
        "female",
        "other"
      ].includes(input.gender)
        ? input.gender
        : oldUser.gender || "other",

    country:
      cleanText(
        input.country ||
        oldUser.country ||
        "",
        10
      ).toUpperCase(),

    avatar:
      input.avatar !== undefined
        ? safeAvatar(input.avatar)
        : oldUser.avatar || ""
  };

  const rows =
    await request(
      "profiles?on_conflict=user_id",
      {
        method: "POST",

        headers: {
          Prefer:
            "resolution=merge-duplicates,return=representation"
        },

        body: JSON.stringify({
          user_id: user.id,
          name: user.name,
          language: user.language,
          age: user.age,
          gender: user.gender,
          country: user.country,
          avatar: user.avatar,
          updated_at:
            new Date().toISOString()
        })
      }
    );

  return (
    rowToUser(rows?.[0]) ||
    user
  );
}

async function publicUser(userId) {
  const user =
    await getUser(userId);

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    name: user.name,
    language: user.language,
    age: user.age,
    gender: user.gender,
    country: user.country,
    avatar: user.avatar
  };
}


/* =========================
   FRIENDS
========================= */

function friendPair(userA, userB) {
  return [
    String(userA),
    String(userB)
  ].sort();
}

async function areFriends(userA, userB) {
  const [a, b] =
    friendPair(userA, userB);

  const rows =
    await request(
      `friendships?user_a=eq.${eq(a)}&user_b=eq.${eq(b)}&select=user_a&limit=1`,
      {
        method: "GET"
      }
    );

  return Boolean(rows?.length);
}

async function makeFriends(userA, userB) {
  const [a, b] =
    friendPair(userA, userB);

  if (
    !a ||
    !b ||
    a === b
  ) {
    return false;
  }

  await request(
    "friendships?on_conflict=user_a,user_b",
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=minimal"
      },

      body: JSON.stringify({
        user_a: a,
        user_b: b
      })
    }
  );

  return true;
}

async function removeFriend(userA, userB) {
  const [a, b] =
    friendPair(userA, userB);

  await request(
    `friendships?user_a=eq.${eq(a)}&user_b=eq.${eq(b)}`,
    {
      method: "DELETE",

      headers: {
        Prefer: "return=minimal"
      }
    }
  );
}

async function getFriends(userId) {
  const rows =
    await request(
      `friendships?or=(user_a.eq.${eq(userId)},user_b.eq.${eq(userId)})&select=user_a,user_b&order=created_at.desc`,
      {
        method: "GET"
      }
    );

  const ids =
    asArray(rows)
      .map(
        row =>
          row.user_a === userId
            ? row.user_b
            : row.user_a
      )
      .filter(Boolean);

  const users =
    await Promise.all(
      ids.map(publicUser)
    );

  return users.filter(Boolean);
}


/* =========================
   CHATS
========================= */

function friendChatId(userA, userB) {
  return (
    "friend_" +
    friendPair(
      userA,
      userB
    ).join("_")
  );
}

async function getChat(chatId) {
  const rows =
    await request(
      `chats?id=eq.${eq(chatId)}&select=*&limit=1`,
      {
        method: "GET"
      }
    );

  return rowToChat(rows?.[0]);
}

async function createFriendChat(
  userA,
  userB
) {
  const [a, b] =
    friendPair(userA, userB);

  const chatId =
    friendChatId(a, b);

  const rows =
    await request(
      "chats?on_conflict=id",
      {
        method: "POST",

        headers: {
          Prefer:
            "resolution=merge-duplicates,return=representation"
        },

        body: JSON.stringify({
          id: chatId,
          user_a: a,
          user_b: b,
          type: "friend",
          match_id: null
        })
      }
    );

  return (
    rowToChat(rows?.[0]) ||
    getChat(chatId)
  );
}

async function createMatchChat(
  matchId,
  userA,
  userB
) {
  const chatId =
    "matchchat_" + matchId;

  const rows =
    await request(
      "chats?on_conflict=id",
      {
        method: "POST",

        headers: {
          Prefer:
            "resolution=merge-duplicates,return=representation"
        },

        body: JSON.stringify({
          id: chatId,
          user_a: userA,
          user_b: userB,
          type: "match",
          match_id: matchId
        })
      }
    );

  return (
    rowToChat(rows?.[0]) ||
    getChat(chatId)
  );
}

async function deleteChat(chatId) {
  await request(
    `chats?id=eq.${eq(chatId)}`,
    {
      method: "DELETE",

      headers: {
        Prefer: "return=minimal"
      }
    }
  );
}


/* =========================
   MESSAGES
========================= */

async function addMessage(
  chatId,
  senderId,
  text
) {
  return addRichMessage(
    chatId,
    senderId,
    {
      type: "text",
      text
    }
  );
}

async function addRichMessage(
  chatId,
  senderId,
  data
) {
  const chat =
    await getChat(chatId);

  if (
    !chat ||
    !chat.users.includes(senderId)
  ) {
    return null;
  }

  const type =
    data?.type === "voice"
      ? "voice"
      : "text";

  const row = {
    id: cryptoRandomId(),
    chat_id: chatId,
    sender_id: senderId,
    type,
    delivered_to: [senderId],
    read_by: [senderId]
  };

  if (type === "text") {
    const text =
      cleanText(
        data.text,
        1000
      );

    if (!text) {
      return null;
    }

    row.text = text;
  } else {
    const audio =
      safeAudio(data.audio);

    if (!audio) {
      return null;
    }

    row.audio = audio;

    row.duration =
      Math.max(
        1,
        Math.min(
          600,
          Number(data.duration) || 1
        )
      );
  }

  const rows =
    await request(
      "messages",
      {
        method: "POST",

        headers: {
          Prefer:
            "return=representation"
        },

        body:
          JSON.stringify(row)
      }
    );

  return rowToMessage(
    rows?.[0]
  );
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : require("crypto").randomUUID();
}

async function getMessages(
  chatId,
  limit = 100
) {
  const safeLimit =
    Math.max(
      1,
      Math.min(
        200,
        Number(limit) || 100
      )
    );

  const rows =
    await request(
      `messages?chat_id=eq.${eq(chatId)}&select=*&order=created_at.desc&limit=${safeLimit}`,
      {
        method: "GET"
      }
    );

  return asArray(rows)
    .reverse()
    .map(rowToMessage);
}

async function markDelivered(
  chatId,
  messageId,
  userId
) {
  const rows =
    await request(
      "rpc/mark_message_delivered",
      {
        method: "POST",

        body:
          JSON.stringify({
            p_chat_id: chatId,
            p_message_id:
              messageId,
            p_user_id:
              userId
          })
      }
    );

  return rowToMessage(
    rows?.[0]
  );
}

async function markChatRead(
  chatId,
  userId
) {
  const rows =
    await request(
      "rpc/mark_chat_read",
      {
        method: "POST",

        body:
          JSON.stringify({
            p_chat_id:
              chatId,
            p_user_id:
              userId
          })
      }
    );

  return asArray(rows)
    .map(
      row =>
        row.message_id
    )
    .filter(Boolean);
}


/* =========================
   BLOCKS
========================= */

async function blockUser(
  userId,
  targetUserId
) {
  if (
    !userId ||
    !targetUserId ||
    userId === targetUserId
  ) {
    return false;
  }

  await request(
    "blocks?on_conflict=blocker_id,blocked_id",
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=minimal"
      },

      body:
        JSON.stringify({
          blocker_id:
            userId,

          blocked_id:
            targetUserId
        })
    }
  );

  await removeFriend(
    userId,
    targetUserId
  );

  return true;
}

async function unblockUser(
  userId,
  targetUserId
) {
  await request(
    `blocks?blocker_id=eq.${eq(userId)}&blocked_id=eq.${eq(targetUserId)}`,
    {
      method: "DELETE",

      headers: {
        Prefer:
          "return=minimal"
      }
    }
  );
}

async function getBlockedUsers(
  userId
) {
  const rows =
    await request(
      `blocks?blocker_id=eq.${eq(userId)}&select=blocked_id&order=created_at.desc`,
      {
        method: "GET"
      }
    );

  const users =
    await Promise.all(
      asArray(rows).map(
        row =>
          publicUser(
            row.blocked_id
          )
      )
    );

  return users.filter(Boolean);
}

async function isBlockedEitherWay(
  userA,
  userB
) {
  const rows =
    await request(
      `blocks?or=(and(blocker_id.eq.${eq(userA)},blocked_id.eq.${eq(userB)}),and(blocker_id.eq.${eq(userB)},blocked_id.eq.${eq(userA)}))&select=blocker_id&limit=1`,
      {
        method: "GET"
      }
    );

  return Boolean(rows?.length);
}


/* =========================
   REPORTS
========================= */

async function reportUser(
  fromUserId,
  targetUserId,
  reason
) {
  await request(
    "reports",
    {
      method: "POST",

      headers: {
        Prefer:
          "return=minimal"
      },

      body:
        JSON.stringify({
          from_user_id:
            fromUserId,

          target_user_id:
            targetUserId,

          reason:
            cleanText(
              reason,
              200
            )
        })
    }
  );
}


/* =========================
   PUSH NOTIFICATIONS
========================= */

async function savePushSubscription(
  userId,
  subscription
) {
  const endpoint =
    cleanText(
      subscription?.endpoint,
      4096
    );

  if (
    !userId ||
    !endpoint
  ) {
    return false;
  }

  await request(
    "push_subscriptions?on_conflict=endpoint",
    {
      method: "POST",

      headers: {
        Prefer:
          "resolution=merge-duplicates,return=minimal"
      },

      body:
        JSON.stringify({
          endpoint,
          user_id:
            userId,
          subscription,
          updated_at:
            new Date()
              .toISOString()
        })
    }
  );

  return true;
}

async function getPushSubscriptions(
  userId
) {
  const rows =
    await request(
      `push_subscriptions?user_id=eq.${eq(userId)}&select=endpoint,subscription`,
      {
        method: "GET"
      }
    );

  return asArray(rows)
    .map(
      row => ({
        endpoint:
          row.endpoint,

        subscription:
          row.subscription
      })
    )
    .filter(
      item =>
        item.subscription
    );
}

async function deletePushSubscription(
  endpoint
) {
  await request(
    `push_subscriptions?endpoint=eq.${eq(endpoint)}`,
    {
      method: "DELETE",

      headers: {
        Prefer:
          "return=minimal"
      }
    }
  );
}


/* =========================
   EXPORTS
========================= */

module.exports = {
  configured,
  ping,
  countUsers,

  createOrUpdateUser,
  getUser,
  publicUser,

  areFriends,
  makeFriends,
  removeFriend,
  getFriends,

  createFriendChat,
  createMatchChat,
  getChat,
  deleteChat,

  addMessage,
  addRichMessage,
  markDelivered,
  markChatRead,
  getMessages,

  blockUser,
  unblockUser,
  getBlockedUsers,
  isBlockedEitherWay,

  reportUser,

  savePushSubscription,
  getPushSubscriptions,
  deletePushSubscription
};
