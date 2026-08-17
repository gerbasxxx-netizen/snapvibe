// SnapVibe — временная база данных
// Позже её можно заменить на PostgreSQL без изменения интерфейса приложения.

// Зарегистрированные пользователи
const users = new Map();

// Друзья пользователя
// userId -> Set(friendId)
const friends = new Map();

// Заявки в друзья
// userId -> Set(userId тех, кто отправил заявку)
const friendRequests = new Map();

// Постоянные чаты между друзьями
// chatId -> объект чата
const chats = new Map();

// Сообщения
// chatId -> массив сообщений
const messages = new Map();

function createUser(user) {
  if (!user || !user.id) {
    throw new Error("User ID is required");
  }

  const newUser = {
    id: user.id,
    name: user.name || "SnapVibe User",
    avatar: user.avatar || null,
    language: user.language || "ru",
    createdAt: Date.now()
  };

  users.set(newUser.id, newUser);

  if (!friends.has(newUser.id)) {
    friends.set(newUser.id, new Set());
  }

  if (!friendRequests.has(newUser.id)) {
    friendRequests.set(newUser.id, new Set());
  }

  return newUser;
}

function getUser(userId) {
  return users.get(userId) || null;
}

function sendFriendRequest(fromUserId, toUserId) {
  if (!fromUserId || !toUserId) return false;
  if (fromUserId === toUserId) return false;

  if (!friendRequests.has(toUserId)) {
    friendRequests.set(toUserId, new Set());
  }

  friendRequests.get(toUserId).add(fromUserId);

  return true;
}

function acceptFriendRequest(userId, fromUserId) {
  const requests = friendRequests.get(userId);

  if (!requests || !requests.has(fromUserId)) {
    return false;
  }

  requests.delete(fromUserId);

  if (!friends.has(userId)) {
    friends.set(userId, new Set());
  }

  if (!friends.has(fromUserId)) {
    friends.set(fromUserId, new Set());
  }

  friends.get(userId).add(fromUserId);
  friends.get(fromUserId).add(userId);

  return true;
}

function getFriends(userId) {
  const list = friends.get(userId);

  if (!list) return [];

  return Array.from(list)
    .map(id => users.get(id))
    .filter(Boolean);
}

function getFriendRequests(userId) {
  const requests = friendRequests.get(userId);

  if (!requests) return [];

  return Array.from(requests)
    .map(id => users.get(id))
    .filter(Boolean);
}

function createChat(userA, userB) {
  const sorted = [userA, userB].sort();

  const chatId = sorted.join("_");

  if (!chats.has(chatId)) {
    chats.set(chatId, {
      id: chatId,
      users: sorted,
      createdAt: Date.now()
    });

    messages.set(chatId, []);
  }

  return chats.get(chatId);
}

function addMessage(chatId, senderId, text) {
  if (!messages.has(chatId)) {
    messages.set(chatId, []);
  }

  const message = {
    id:
      Date.now().toString(36) +
      Math.random().toString(36).slice(2),

    senderId,
    text: String(text || "").trim(),
    createdAt: Date.now()
  };

  if (!message.text) {
    return null;
  }

  messages.get(chatId).push(message);

  return message;
}

function getMessages(chatId) {
  return messages.get(chatId) || [];
}

module.exports = {
  users,
  friends,
  friendRequests,
  chats,
  messages,

  createUser,
  getUser,

  sendFriendRequest,
  acceptFriendRequest,
  getFriends,
  getFriendRequests,

  createChat,
  addMessage,
  getMessages
};
