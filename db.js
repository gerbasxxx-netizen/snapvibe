const crypto = require("crypto");

const users = new Map();
const friends = new Map();
const chats = new Map();
const messages = new Map();
const reports = [];
const blocks = new Map();

function ensure(userId) {
  if (!friends.has(userId)) {
    friends.set(userId, new Set());
  }

  if (!blocks.has(userId)) {
    blocks.set(userId, new Set());
  }
}

function clean(value, max = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function safeAvatar(value) {
  const avatar = String(value || "");

  if (
    avatar.startsWith("data:image/") &&
    Buffer.byteLength(avatar, "utf8") <=
      5 * 1024 * 1024
  ) {
    return avatar;
  }

  return "";
}

function createOrUpdateUser(input) {
  if (!input?.id) {
    throw new Error(
      "User ID required"
    );
  }

  const old =
    users.get(input.id) || {};

  const user = {
    id:
      input.id,

    name:
      clean(
        input.name ||
          old.name ||
          "SnapVibe User",
        30
      ),

    language:
      clean(
        input.language ||
          old.language ||
          "en",
        8
      ),

    age:
      input.age
        ? Math.max(
            18,
            Math.min(
              99,
              Number(
                input.age
              )
            )
          )
        : old.age ||
          null,

    gender:
      [
        "male",
        "female",
        "other"
      ].includes(
        input.gender
      )
        ? input.gender
        : old.gender ||
          "other",

    country:
      clean(
        input.country ||
          old.country ||
          "",
        60
      ),

    avatar:
      input.avatar !==
      undefined
        ? safeAvatar(
            input.avatar
          )
        : old.avatar ||
          "",

    createdAt:
      old.createdAt ||
      Date.now(),

    updatedAt:
      Date.now()
  };

  users.set(
    user.id,
    user
  );

  ensure(
    user.id
  );

  return user;
}

function getUser(userId) {
  return (
    users.get(userId) ||
    null
  );
}

function publicUser(userId) {
  const user =
    getUser(userId);

  if (!user) {
    return null;
  }

  return {
    id:
      user.id,

    name:
      user.name,

    language:
      user.language,

    age:
      user.age,

    gender:
      user.gender,

    country:
      user.country,

    avatar:
      user.avatar
  };
}

function areFriends(
  userA,
  userB
) {
  return !!friends
    .get(userA)
    ?.has(userB);
}

function makeFriends(
  userA,
  userB
) {
  ensure(userA);
  ensure(userB);

  friends
    .get(userA)
    .add(userB);

  friends
    .get(userB)
    .add(userA);
}

function removeFriend(
  userA,
  userB
) {
  friends
    .get(userA)
    ?.delete(userB);

  friends
    .get(userB)
    ?.delete(userA);
}

function getFriends(
  userId
) {
  ensure(userId);

  return [
    ...friends.get(userId)
  ]
    .map(publicUser)
    .filter(Boolean);
}

function friendChatId(
  userA,
  userB
) {
  return (
    "friend_" +
    [userA, userB]
      .sort()
      .join("_")
  );
}

function createFriendChat(
  userA,
  userB
) {
  const chatId =
    friendChatId(
      userA,
      userB
    );

  if (
    !chats.has(
      chatId
    )
  ) {
    chats.set(
      chatId,
      {
        id:
          chatId,

        users:
          [
            userA,
            userB
          ].sort(),

        type:
          "friend",

        createdAt:
          Date.now()
      }
    );

    messages.set(
      chatId,
      []
    );
  }

  return chats.get(
    chatId
  );
}

function createMatchChat(
  matchId,
  userA,
  userB
) {
  const chatId =
    "matchchat_" +
    matchId;

  chats.set(
    chatId,
    {
      id:
        chatId,

      users: [
        userA,
        userB
      ],

      type:
        "match",

      matchId,

      createdAt:
        Date.now()
    }
  );

  messages.set(
    chatId,
    []
  );

  return chats.get(
    chatId
  );
}

function getChat(
  chatId
) {
  return (
    chats.get(chatId) ||
    null
  );
}

function deleteChat(
  chatId
) {
  chats.delete(
    chatId
  );

  messages.delete(
    chatId
  );
}

function addMessage(
  chatId,
  senderId,
  text
) {
  const chat =
    chats.get(
      chatId
    );

  if (
    !chat ||
    !chat.users.includes(
      senderId
    )
  ) {
    return null;
  }

  const messageText =
    clean(
      text,
      1000
    );

  if (!messageText) {
    return null;
  }

  const message = {
    id:
      crypto.randomUUID(),

    chatId,

    senderId,

    text:
      messageText,

    createdAt:
      Date.now()
  };

  if (
    !messages.has(
      chatId
    )
  ) {
    messages.set(
      chatId,
      []
    );
  }

  messages
    .get(chatId)
    .push(message);

  if (
    messages
      .get(chatId)
      .length > 500
  ) {
    messages
      .get(chatId)
      .splice(
        0,
        messages
          .get(chatId)
          .length -
          500
      );
  }

  return message;
}

function getMessages(
  chatId,
  limit = 100
) {
  const list =
    messages.get(chatId) ||
    [];

  return list.slice(
    -Math.max(
      1,
      Math.min(
        200,
        limit
      )
    )
  );
}

function blockUser(
  userId,
  targetUserId
) {
  ensure(userId);

  blocks
    .get(userId)
    .add(
      targetUserId
    );

  removeFriend(
    userId,
    targetUserId
  );
}

function isBlockedEitherWay(
  userA,
  userB
) {
  return (
    !!blocks
      .get(userA)
      ?.has(userB) ||

    !!blocks
      .get(userB)
      ?.has(userA)
  );
}

function reportUser(
  fromUserId,
  targetUserId,
  reason
) {
  reports.push({
    id:
      crypto.randomUUID(),

    fromUserId,

    targetUserId,

    reason:
      clean(
        reason,
        120
      ),

    createdAt:
      Date.now()
  });
}

module.exports = {
  users,
  friends,
  chats,
  messages,
  reports,
  blocks,

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
  getMessages,

  blockUser,
  isBlockedEitherWay,

  reportUser
};
