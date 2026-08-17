/*
 * Service worker (background).
 *
 * Хранит белый список сайтов, добавленных пользователем, и (пере)регистрирует
 * динамический content-скрипт ровно для этих сайтов. По умолчанию расширение
 * не имеет ни одного host-разрешения — content-скрипт просто неоткуда注入.
 *
 * Сайт добавляется в popup через chrome.permissions.request (user gesture),
 * а здесь мы только сохраняем его в storage и обновляем регистрацию скрипта.
 */

"use strict";

const SCRIPT_ID = "inn-filler";
const STORAGE_KEY = "allowedSites";

// Файлы content-скрипта. generators.js — UMD, кладёт RusID в общий global
// изолированного мира; content.js читает его оттуда.
const CONTENT_JS = ["lib/generators.js", "content/content.js"];
const CONTENT_CSS = ["content/content.css"];

// --- Работа с хранилищем ---
async function getAllowedSites() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function setAllowedSites(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
}

// --- (Пере)регистрация динамического content-скрипта ---
async function syncScripts() {
  const matches = await getAllowedSites();
  try {
    // Снимаем прошлую регистрацию (.ignore ошибки, если её не было).
    await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch (_) {
    /* нет такой регистрации — нормально */
  }
  if (matches.length === 0) return;
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: SCRIPT_ID,
        matches,
        js: CONTENT_JS,
        css: CONTENT_CSS,
        runAt: "document_idle",
        allFrames: false,
        persistAcrossReloads: true,
      },
    ]);
  } catch (err) {
    console.error("[inn-filler] не удалось зарегистрировать content-скрипт:", err);
  }
}

// --- Восстановление при установке/обновлении/запуске браузера ---
chrome.runtime.onInstalled.addListener(() => {
  syncScripts();
});
chrome.runtime.onStartup.addListener(() => {
  syncScripts();
});

// --- Сообщения от popup ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "GET_STATE") {
        sendResponse({ ok: true, allowedSites: await getAllowedSites() });
        return;
      }
      if (msg?.type === "ADD_SITE" && typeof msg.pattern === "string") {
        const list = await getAllowedSites();
        if (!list.includes(msg.pattern)) list.push(msg.pattern);
        await setAllowedSites(list);
        await syncScripts();
        sendResponse({ ok: true, allowedSites: list });
        return;
      }
      if (msg?.type === "REMOVE_SITE" && typeof msg.pattern === "string") {
        const list = (await getAllowedSites()).filter((p) => p !== msg.pattern);
        await setAllowedSites(list);
        await syncScripts();
        sendResponse({ ok: true, allowedSites: list });
        return;
      }
      sendResponse({ ok: false, error: "unknown_message" });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // асинхронный ответ
});
