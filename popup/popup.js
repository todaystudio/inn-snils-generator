/*
 * Логика popup: переключение типа документа, генерация, копирование.
 */

(function () {
  "use strict";

  // Человекочитаемые названия для подписи под значением.
  const TYPE_LABELS = {
    fl: "физическое лицо · ИНН",
    ip: "индивидуальный предприниматель · ИНН",
    ul: "юридическое лицо · ИНН",
    snils: "страховой номер · СНИЛС",
  };

  // Функции генерации по ключу типа.
  const GENERATORS = {
    fl: () => RusID.formatInn(RusID.generateInnFl()),
    ip: () => RusID.formatInn(RusID.generateInnIp()),
    ul: () => RusID.formatInn(RusID.generateInnUl()),
    snils: () => RusID.generateSnils(),
  };

  const resultValue = document.getElementById("resultValue");
  const resultType = document.getElementById("resultType");
  const resultCard = document.getElementById("resultCard");
  const copyBtn = document.getElementById("copyBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const typeInputs = document.querySelectorAll('input[name="type"]');

  let currentType = "fl";
  let currentValue = "";

  // --- Генерация ---
  function regenerate() {
    currentValue = GENERATORS[currentType]();
    resultValue.textContent = currentValue;
    resultType.textContent = TYPE_LABELS[currentType];
  }

  // --- Копирование в буфер обмена ---
  async function copyValue() {
    if (!currentValue) return;
    const btnText = copyBtn.querySelector(".btn__text");
    try {
      // Современный API, работает в popup без разрешений.
      await navigator.clipboard.writeText(currentValue);
    } catch {
      // Запасной путь для старых/строгих окружений.
      fallbackCopy(currentValue);
    }
    // Визуальный feedback.
    const originalText = btnText.textContent;
    btnText.textContent = "Скопировано";
    copyBtn.classList.add("is-copied");
    resultCard.classList.add("is-copied");
    setTimeout(() => {
      btnText.textContent = originalText;
      copyBtn.classList.remove("is-copied");
      resultCard.classList.remove("is-copied");
    }, 1200);
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(ta);
    }
  }

  // --- Переключение типа ---
  typeInputs.forEach((input) => {
    input.addEventListener("change", () => {
      currentType = input.value;
      regenerate();
    });
  });

  // --- События ---
  copyBtn.addEventListener("click", copyValue);
  refreshBtn.addEventListener("click", regenerate);

  // Карточка результата тоже копирует по клику.
  resultCard.addEventListener("click", copyValue);
  resultCard.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      copyValue();
    }
  });

  // Горячие клавиши: R — новое, C — копировать.
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === "r" || e.key === "R") regenerate();
    if (e.key === "c" || e.key === "C") copyValue();
  });

  // Стартовая генерация при открытии popup.
  regenerate();
})();

/*
 * Менеджер сайтов: добавление/удаление текущего сайта в белый список.
 * По умолчанию расширение не работает ни на одном сайте — пользователь явно
 * добавляет нужный сайт, после чего на нём работает авто-определение полей.
 *
 * После подтверждения разрешения сайт попадает в список автоматически
 * (background слушает permissions.onAdded) — даже если popup закрылся.
 * Здесь же — мгновенная инъекция скрипта в текущую вкладку без перезагрузки.
 */
(function () {
  "use strict";

  const siteCard = document.getElementById("siteCard");
  const siteHost = document.getElementById("siteHost");
  const siteStatus = document.getElementById("siteStatus");
  const siteBtn = document.getElementById("siteBtn");

  const CONTENT_JS = ["lib/data.js", "lib/generators.js", "content/content.js"];
  const CONTENT_CSS = ["content/content.css"];

  function sendMessage(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
  }

  function patternFrom(url) {
    const u = new URL(url);
    return u.protocol + "//" + u.host + "/*";
  }

  function hostFrom(url) {
    return new URL(url).host;
  }

  function render(isAllowed) {
    if (isAllowed) {
      siteCard.classList.add("is-active");
      siteStatus.textContent = "Работает на этом сайте";
      siteBtn.textContent = "Удалить этот сайт";
      siteBtn.dataset.state = "remove";
    } else {
      siteCard.classList.remove("is-active");
      siteStatus.textContent = "Не активен на этом сайте";
      siteBtn.textContent = "Добавить этот сайт";
      siteBtn.dataset.state = "add";
    }
  }

  async function injectNow(tabId) {
    // Активируем сразу на текущей странице (во все фреймы), не дожидаясь
    // перезагрузки. Content-скрипт сам защищён от повторного запуска.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: CONTENT_JS,
        injectImmediately: true,
      });
      await chrome.scripting.insertCSS({
        target: { tabId, allFrames: true },
        files: CONTENT_CSS,
      });
    } catch (err) {
      // Не критично: на следующей загрузке сработает зарегистрированный скрипт.
      console.warn("[inn-filler] не удалось внедрить сразу:", err);
    }
  }

  async function toggle(tab, pattern, isAllowed) {
    siteBtn.disabled = true;
    try {
      if (!isAllowed) {
        // Если разрешение уже выдано (сайт когда-то добавляли) — диалог не нужен.
        const already = await chrome.permissions.contains({ origins: [pattern] });
        if (!already) {
          // Запрос разрешения только для этого сайта (нужен user-gesture — клик).
          const granted = await chrome.permissions.request({ origins: [pattern] });
          if (!granted) return; // пользователь отказал — сайт не добавляем
        }
        // Дальше сайт добавится при любом исходе: background слушает
        // permissions.onAdded, сообщение — дублирующий путь.
        await sendMessage({ type: "ADD_SITE", pattern });
        await injectNow(tab.id);
        render(true);
      } else {
        await chrome.permissions.remove({ origins: [pattern] });
        await sendMessage({ type: "REMOVE_SITE", pattern });
        render(false);
      }
    } catch (err) {
      console.error("[inn-filler] ошибка переключения сайта:", err);
      // Перерисовываем по фактическому состоянию — возможно, всё уже сработало.
      const res = await sendMessage({ type: "GET_STATE" });
      const allowed = Array.isArray(res?.allowedSites) ? res.allowedSites : [];
      render(allowed.includes(pattern));
    } finally {
      siteBtn.disabled = false;
    }
  }

  async function init() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;
    let url;
    try {
      url = new URL(tab.url);
    } catch (_) {
      return;
    }
    // Разрешение можно запросить только для http/https.
    if (url.protocol !== "http:" && url.protocol !== "https:") return;

    const pattern = patternFrom(tab.url);
    siteHost.textContent = hostFrom(tab.url);
    siteCard.hidden = false;

    const res = await sendMessage({ type: "GET_STATE" });
    const allowed = Array.isArray(res?.allowedSites) ? res.allowedSites : [];
    render(allowed.includes(pattern));

    siteBtn.addEventListener("click", () => {
      const isAllowed = siteBtn.dataset.state === "remove";
      toggle(tab, pattern, isAllowed);
    });
  }

  init();
})();
