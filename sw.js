"use strict";

const CACHE_NAME = "snapvibe-v1";

/*
  Установка Service Worker
*/
self.addEventListener("install", event => {
  self.skipWaiting();
});


/*
  Новый Service Worker сразу становится активным
*/
self.addEventListener("activate", event => {
  event.waitUntil(
    self.clients.claim()
  );
});


/*
  Получаем PUSH-уведомление от сервера
*/
self.addEventListener("push", event => {

  let data = {};

  try {
    data = event.data
      ? event.data.json()
      : {};
  } catch (error) {
    data = {
      title: "SnapVibe",
      body: event.data
        ? event.data.text()
        : "Новое уведомление"
    };
  }


  const title =
    data.title || "SnapVibe";


  let body =
    data.body || "Новое уведомление";


  /*
    Для разных типов уведомлений
  */
  if (
    data.type === "incoming_call"
  ) {

    body =
      data.callType === "video"
        ? "📹 Входящий видеозвонок"
        : "📞 Входящий аудиозвонок";

  }


  const options = {

    body,

    icon:
      data.icon ||
      "/icon-192.png",

    badge:
      "/icon-192.png",

    tag:
      data.type === "incoming_call"
        ? "snapvibe-call-" +
          (data.callId || "new")
        : "snapvibe-chat-" +
          (data.chatId || "new"),

    renotify: true,

    vibrate: [
      200,
      100,
      200
    ],

    data: {

      type:
        data.type || "notification",

      chatId:
        data.chatId || null,

      callId:
        data.callId || null,

      callType:
        data.callType || null,

      fromUserId:
        data.fromUserId ||
        data.senderId ||
        null,

      url:
        data.url ||
        "/preview3.html"

    }

  };


  /*
    Для входящего звонка
    вибрация длиннее
  */
  if (
    data.type === "incoming_call"
  ) {

    options.vibrate = [
      400,
      200,
      400,
      200,
      400
    ];

    options.requireInteraction =
      true;

  }


  event.waitUntil(
    self.registration
      .showNotification(
        title,
        options
      )
  );

});


/*
  Пользователь нажал на уведомление
*/
self.addEventListener(
  "notificationclick",
  event => {

    event.notification.close();


    const data =
      event.notification.data || {};


    let targetUrl =
      data.url ||
      "/preview3.html";


    /*
      Если это сообщение —
      передаём ID чата
    */
    if (
      data.type === "chat_message" &&
      data.chatId
    ) {

      targetUrl =
        "/preview3.html?chat=" +
        encodeURIComponent(
          data.chatId
        );

    }


    /*
      Если это звонок
    */
    if (
      data.type === "incoming_call" &&
      data.callId
    ) {

      targetUrl =
        "/preview3.html?call=" +
        encodeURIComponent(
          data.callId
        );

    }


    event.waitUntil(

      self.clients
        .matchAll({
          type: "window",
          includeUncontrolled: true
        })
        .then(clientList => {

          /*
            Если SnapVibe уже открыт —
            открываем его окно
          */
          for (
            const client
            of clientList
          ) {

            if (
              "focus" in client
            ) {

              client.postMessage({

                type:
                  "notification_open",

                notificationType:
                  data.type,

                chatId:
                  data.chatId,

                callId:
                  data.callId,

                fromUserId:
                  data.fromUserId

              });


              return client
                .focus()
                .then(() => {

                  if (
                    "navigate" in client
                  ) {

                    return client.navigate(
                      targetUrl
                    );

                  }

                });

            }

          }


          /*
            Если приложение закрыто —
            открываем новое окно
          */
          if (
            self.clients.openWindow
          ) {

            return self.clients
              .openWindow(
                targetUrl
              );

          }

        })

    );

  }
);


/*
  Закрытие уведомления
*/
self.addEventListener(
  "notificationclose",
  event => {

    console.log(
      "SnapVibe notification closed",
      event.notification.tag
    );

  }
);
