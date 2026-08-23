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
