const crypto =
  require("crypto");

const users =
  new Map();

const friends =
  new Map();

const chats =
  new Map();

const messages =
  new Map();

const reports =
  [];

const blocks =
  new Map();


function ensureUser(
  userId
) {

  if (
    !friends.has(
      userId
    )
  ) {
    friends.set(
      userId,
      new Set()
    );
  }


  if (
    !blocks.has(
      userId
    )
  ) {
    blocks.set(
      userId,
      new Set()
    );
  }

}


function cleanText(
  value,
  maxLength = 500
) {

  return String(
    value ?? ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );

}


function safeAvatar(
  value
) {

  const avatar =
    String(
      value || ""
    );


  if (
    avatar.startsWith(
      "data:image/"
    ) &&
    Buffer.byteLength(
      avatar,
      "utf8"
    ) <=
      5 * 1024 * 1024
  ) {
    return avatar;
  }


  return "";

}


function safeAudio(
  value
) {

  const audio =
    String(
      value || ""
    );


  const validType =
    audio.startsWith(
      "data:audio/"
    ) ||
    audio.startsWith(
      "data:application/octet-stream"
    );


  if (
    validType &&
    Buffer.byteLength(
      audio,
      "utf8"
    ) <=
      8 * 1024 * 1024
  ) {
    return audio;
  }


  return "";

}


/* USERS */

function createOrUpdateUser(
  input
) {

  if (
    !input?.id
  ) {
    throw new Error(
      "User ID required"
    );
  }


  const oldUser =
    users.get(
      input.id
    ) || {};


  const user = {

    id:
      input.id,

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
        : oldUser.age ||
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
        : oldUser.gender ||
          "other",

    country:
      cleanText(
        input.country ||
        oldUser.country ||
        "",
        10
      )
        .toUpperCase(),

    avatar:
      input.avatar !==
      undefined
        ? safeAvatar(
            input.avatar
          )
        : oldUser.avatar ||
          "",

    createdAt:
      oldUser.createdAt ||
      Date.now(),

    updatedAt:
      Date.now()

  };


  users.set(
    user.id,
    user
  );


  ensureUser(
    user.id
  );


  return user;

}


function getUser(
  userId
) {

  return (
    users.get(
      userId
    ) ||
    null
  );

}


function publicUser(
  userId
) {

  const user =
    getUser(
      userId
    );


  if (
    !user
  ) {
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


/* FRIENDS */

function areFriends(
  userA,
  userB
) {

  return !!friends
    .get(
      userA
    )
    ?.has(
      userB
    );

}


function makeFriends(
  userA,
  userB
) {

  ensureUser(
    userA
  );

  ensureUser(
    userB
  );


  friends
    .get(
      userA
    )
    .add(
      userB
    );


  friends
    .get(
      userB
    )
    .add(
      userA
    );

}


function removeFriend(
  userA,
  userB
) {

  friends
    .get(
      userA
    )
    ?.delete(
      userB
    );


  friends
    .get(
      userB
    )
    ?.delete(
      userA
    );

}


function getFriends(
  userId
) {

  ensureUser(
    userId
  );


  return [
    ...friends.get(
      userId
    )
  ]
    .map(
      publicUser
    )
    .filter(
      Boolean
    );

}


/* CHATS */

function friendChatId(
  userA,
  userB
) {

  return (
    "friend_" +
    [
      userA,
      userB
    ]
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
    chats.get(
      chatId
    ) ||
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


/* MESSAGE HELPERS */

function ensureMessageList(
  chatId
) {

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


  return messages.get(
    chatId
  );

}


function baseMessage(
  chatId,
  senderId,
  type
) {

  return {

    id:
      crypto.randomUUID(),

    chatId,

    senderId,

    type,

    createdAt:
      Date.now(),

    deliveredTo:
      [
        senderId
      ],

    readBy:
      [
        senderId
      ]

  };

}


/* OLD TEXT MESSAGE COMPATIBILITY */

function addMessage(
  chatId,
  senderId,
  text
) {

  return addRichMessage(
    chatId,
    senderId,
    {
      type:
        "text",

      text
    }
  );

}


/* TEXT + VOICE */

function addRichMessage(
  chatId,
  senderId,
  data
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


  const type =
    data?.type ===
    "voice"
      ? "voice"
      : "text";


  const message =
    baseMessage(
      chatId,
      senderId,
      type
    );


  if (
    type ===
    "text"
  ) {

    const text =
      cleanText(
        data.text,
        1000
      );


    if (
      !text
    ) {
      return null;
    }


    message.text =
      text;

  }


  if (
    type ===
    "voice"
  ) {

    const audio =
      safeAudio(
        data.audio
      );


    if (
      !audio
    ) {
      return null;
    }


    message.audio =
      audio;


    message.duration =
      Math.max(
        1,
        Math.min(
          600,
          Number(
            data.duration
          ) || 1
        )
      );

  }


  const list =
    ensureMessageList(
      chatId
    );


  list.push(
    message
  );


  /* чтобы память сервера не росла бесконечно */

  if (
    list.length >
    500
  ) {

    list.splice(
      0,
      list.length -
      500
    );

  }


  return message;

}


/* MESSAGE STATUS */

function findMessage(
  chatId,
  messageId
) {

  const list =
    messages.get(
      chatId
    ) || [];


  return list.find(
    item =>
      item.id ===
      messageId
  ) || null;

}


function markDelivered(
  chatId,
  messageId,
  userId
) {

  const chat =
    chats.get(
      chatId
    );


  if (
    !chat ||
    !chat.users.includes(
      userId
    )
  ) {
    return null;
  }


  const message =
    findMessage(
      chatId,
      messageId
    );


  if (
    !message
  ) {
    return null;
  }


  if (
    !Array.isArray(
      message.deliveredTo
    )
  ) {
    message.deliveredTo =
      [];
  }


  if (
    !message.deliveredTo.includes(
      userId
    )
  ) {

    message.deliveredTo.push(
      userId
    );

  }


  return message;

}


function markChatRead(
  chatId,
  userId
) {

  const chat =
    chats.get(
      chatId
    );


  if (
    !chat ||
    !chat.users.includes(
      userId
    )
  ) {
    return [];
  }


  const list =
    messages.get(
      chatId
    ) || [];


  const updatedIds =
    [];


  list.forEach(
    message => {

      /*
       * свои сообщения
       * пользователь не должен
       * "прочитывать" повторно
       */

      if (
        message.senderId ===
        userId
      ) {
        return;
      }


      if (
        !Array.isArray(
          message.deliveredTo
        )
      ) {
        message.deliveredTo =
          [];
      }


      if (
        !message.deliveredTo.includes(
          userId
        )
      ) {

        message.deliveredTo.push(
          userId
        );

      }


      if (
        !Array.isArray(
          message.readBy
        )
      ) {
        message.readBy =
          [];
      }


      if (
        !message.readBy.includes(
          userId
        )
      ) {

        message.readBy.push(
          userId
        );


        updatedIds.push(
          message.id
        );

      }

    }
  );


  return updatedIds;

}


function getMessages(
  chatId,
  limit = 100
) {

  const list =
    messages.get(
      chatId
    ) || [];


  const safeLimit =
    Math.max(
      1,
      Math.min(
        200,
        Number(
          limit
        ) || 100
      )
    );


  return list.slice(
    -safeLimit
  );

}


/* BLOCKS */

function blockUser(
  userId,
  targetUserId
) {

  ensureUser(
    userId
  );


  blocks
    .get(
      userId
    )
    .add(
      targetUserId
    );


  removeFriend(
    userId,
    targetUserId
  );

}


function unblockUser(
  userId,
  targetUserId
) {

  blocks
    .get(
      userId
    )
    ?.delete(
      targetUserId
    );

}


function getBlockedUsers(
  userId
) {

  ensureUser(
    userId
  );


  return [
    ...blocks.get(
      userId
    )
  ]
    .map(
      publicUser
    )
    .filter(
      Boolean
    );

}


function isBlockedEitherWay(
  userA,
  userB
) {

  return (
    !!blocks
      .get(
        userA
      )
      ?.has(
        userB
      )
    ||
    !!blocks
      .get(
        userB
      )
      ?.has(
        userA
      )
  );

}


/* REPORTS */

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
      cleanText(
        reason,
        200
      ),

    createdAt:
      Date.now()

  });


  if (
    reports.length >
    5000
  ) {

    reports.splice(
      0,
      reports.length -
      5000
    );

  }

}


/* EXPORTS */

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
  addRichMessage,

  markDelivered,
  markChatRead,

  getMessages,

  blockUser,
  unblockUser,
  getBlockedUsers,
  isBlockedEitherWay,

  reportUser

};
