/*
 * Content script: авто-определение полей ИНН/СНИЛС и кнопка-вставка рядом.
 *
 * Грузится ТОЛЬКО на сайтах, добавленных пользователем (динамическая регистрация
 * из background/sw.js). Здесь — поиск полей, плавающие чипы, вставка значения
 * с учётом React/Vue (нативный setter + события input/change).
 *
 * RusID доступен глобально из lib/generators.js (тот же изолированный мир).
 */

(function () {
  "use strict";

  if (window.__innfillerStarted) return;
  window.__innfillerStarted = true;

  const RusID = globalThis.RusID;
  if (!RusID) return; // что-то пошло не так со загрузкой генераторов

  // --- Иконки (inline, чтобы не зависеть от загрузки файлов на странице) ---
  const SPARKLE_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<path d="M12 3l1.9 5.6a4 4 0 0 0 2.5 2.5L22 13l-5.6 1.9a4 4 0 0 0-2.5 2.5L12 23l-1.9-5.6a4 4 0 0 0-2.5-2.5L2 13l5.6-1.9a4 4 0 0 0 2.5-2.5L12 3z" fill="currentColor"/>' +
    '<circle cx="19" cy="5" r="1.4" fill="currentColor" opacity=".75"/></svg>';

  const CHECK_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
    '<path d="M5 12.5l4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // --- Типы полей, в которые имеет смысл подставлять ---
  const ALLOWED_TYPES = new Set(["text", "tel", "number", "search", "", undefined, null]);

  // --- Геометрия ---
  const ICON = 24; // диаметр круглой иконки
  const GAP_INPUT = 6; // отступ чипа от внешнего края поля
  const GAP_INNER = 5; // зазор между иконкой и кнопками ФЛ/ЮЛ
  const EXPAND_W = 76; // ширина раскрытого блока ФЛ/ЮЛ
  const VP_MARGIN = 12; // запас, чтобы считать поле «во вьюпорте»

  // --- Распознавание ---
  function labelTextFor(input) {
    if (input.id) {
      const lab = document.querySelector('label[for="' + cssEscape(input.id) + '"]');
      if (lab) return lab.textContent;
    }
    const wrapping = input.closest("label");
    if (wrapping) return wrapping.textContent;
    return "";
  }

  function fieldSignal(input) {
    const parts = [];
    const push = (s) => {
      if (s) parts.push(String(s).toLowerCase());
    };
    push(input.name);
    push(input.id);
    push(input.placeholder);
    push(input.getAttribute("aria-label"));
    push(input.getAttribute("autocomplete"));
    push(input.getAttribute("data-name"));
    push(input.getAttribute("data-testid"));
    push(input.getAttribute("title"));
    push(labelTextFor(input));

    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      labelledBy
        .split(/\s+/)
        .forEach((id) => {
          const el = document.getElementById(id);
          if (el) push(el.textContent);
        });
    }
    const fieldset = input.closest("fieldset");
    if (fieldset) {
      const legend = fieldset.querySelector("legend");
      if (legend) push(legend.textContent);
    }
    return parts.join(" ");
  }

  function detectKind(signal) {
    if (/снилс/i.test(signal) || /\bsnils\b/i.test(signal)) return "snils";
    if (/инн/i.test(signal) || /\binn\b/i.test(signal) || /\btax_?id\b/i.test(signal) || /\btaxpayer\b/i.test(signal))
      return "inn";
    return null;
  }

  function isCandidate(input) {
    if (!(input instanceof HTMLInputElement)) return false;
    if (input.disabled || input.readOnly) return false;
    const t = (input.type || "").toLowerCase();
    return ALLOWED_TYPES.has(t);
  }

  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // --- Вставка значения (совместимо с React/Vue/Angular) ---
  function setValue(input, value) {
    const proto = HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      input.focus();
      input.select();
    } catch (_) {
      /* some inputs don't support select() */
    }
  }

  function generate(kind) {
    if (kind === "snils") return RusID.generateSnils();
    if (kind === "ul") return RusID.formatInn(RusID.generateInnUl());
    return RusID.formatInn(RusID.generateInnFl()); // fl & ip — один формат
  }

  // --- Создание чипа ---
  function buildChip(kind) {
    const root = document.createElement("div");
    root.className = "innfiller-chip innfiller-chip--" + kind;

    if (kind === "snils") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "innfiller-chip__main innfiller-chip__main--btn";
      btn.title = "Вставить СНИЛС";
      btn.setAttribute("aria-label", "Вставить СНИЛС");
      btn.innerHTML = '<span class="innfiller-icon">' + SPARKLE_SVG + "</span>" +
        '<span class="innfiller-icon innfiller-icon--ok">' + CHECK_SVG + "</span>";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        insertInto(btn, "snils");
      });
      root.appendChild(btn);
      return root;
    }

    // INN: раскрывающийся чип
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Вставить ИНН");

    const expand = document.createElement("div");
    expand.className = "innfiller-chip__expand";

    const fl = document.createElement("button");
    fl.type = "button";
    fl.className = "innfiller-sub";
    fl.dataset.kind = "fl";
    fl.title = "ИНН физлица / ИП — 12 цифр";
    fl.textContent = "ФЛ";

    const ul = document.createElement("button");
    ul.type = "button";
    ul.className = "innfiller-sub";
    ul.dataset.kind = "ul";
    ul.title = "ИНН юрлица — 10 цифр";
    ul.textContent = "ЮЛ";

    expand.appendChild(fl);
    expand.appendChild(ul);

    const main = document.createElement("span");
    main.className = "innfiller-chip__main";
    main.title = "Вставить ИНН";
    main.innerHTML = '<span class="innfiller-icon">' + SPARKLE_SVG + "</span>" +
      '<span class="innfiller-icon innfiller-icon--ok">' + CHECK_SVG + "</span>";

    [fl, ul].forEach((b) =>
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        insertInto(b, b.dataset.kind);
      })
    );

    root.appendChild(expand);
    root.appendChild(main);
    return root;
  }

  // Найти целевой input: для INN-чипа — по привязке, для СНИЛС — это сама кнопка.
  function chipTargetInput(chip) {
    return chip.__innfillerInput || null;
  }

  function insertInto(btn, kind) {
    const chip = btn.closest(".innfiller-chip");
    const input = chipTargetInput(chip);
    if (!input) return;
    setValue(input, generate(kind));
    flashDone(chip);
  }

  function flashDone(chip) {
    chip.classList.add("is-done");
    window.setTimeout(() => chip.classList.remove("is-done"), 900);
  }

  // --- Реестр отслеживаемых полей ---
  const tracked = new Map(); // input -> chip

  function attachChip(input, kind) {
    input.dataset.innfiller = kind; // маркер, чтобы не обработать повторно
    const chip = buildChip(kind);
    chip.__innfillerInput = input;
    chip.style.display = "none"; // скрыт до первого позиционирования в relayout
    document.body.appendChild(chip);

    // Раскрытие по фокусу на поле (клавиатура + надёжность при blur→click).
    if (kind === "inn") {
      input.addEventListener("focus", () => chip.classList.add("is-open"));
      input.addEventListener("blur", () => {
        // Небольшая задержка, чтобы клик по ФЛ/ЮЛ успел сработать после blur.
        setTimeout(() => {
          if (!chip.matches(":hover")) chip.classList.remove("is-open");
        }, 150);
      });
    }

    tracked.set(input, chip);
  }

  // --- Сканирование DOM ---
  function scan() {
    const inputs = document.getElementsByTagName("input");
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      if (tracked.has(input)) continue;
      if (input.dataset.innfiller) continue;
      if (!isCandidate(input)) continue;
      const kind = detectKind(fieldSignal(input));
      if (!kind) continue;
      attachChip(input, kind);
    }
    // Чистим отвалившиеся поля
    for (const [input, chip] of tracked) {
      if (!document.documentElement.contains(input)) {
        chip.remove();
        tracked.delete(input);
      }
    }
  }

  // --- Позиционирование чипов (fixed, СНАРУЖИ поля, с авто-выбором стороны) ---
  function relayout() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const [input, chip] of tracked) {
      if (!isVisible(input)) {
        chip.style.display = "none";
        continue;
      }
      const r = input.getBoundingClientRect();
      // Поле вне вьюпорта — прячем чип
      if (r.bottom < VP_MARGIN || r.top > vh - VP_MARGIN || r.right < VP_MARGIN || r.left > vw - VP_MARGIN) {
        chip.style.display = "none";
        continue;
      }
      chip.style.display = "";
      // Вертикаль — по центру поля (transform: translateY(-50%) доворачивает).
      chip.style.top = r.top + r.height / 2 + "px";

      // Сколько места нужно снаружи поля: для ИНН — с учётом раскрытия ФЛ/ЮЛ.
      const isSnils = chip.classList.contains("innfiller-chip--snils");
      const need = isSnils ? ICON + GAP_INPUT : ICON + GAP_INNER + EXPAND_W + GAP_INPUT;
      const spaceRight = vw - r.right;
      const spaceLeft = r.left;
      let side;
      if (spaceRight >= need) side = "right";
      else if (spaceLeft >= need) side = "left";
      else side = spaceRight >= spaceLeft ? "right" : "left";

      if (side === "right") {
        // Левый край чипа = правый край поля + отступ; раскрытие растёт вправо.
        chip.style.left = r.right + GAP_INPUT + "px";
        chip.style.right = "auto";
        chip.classList.add("innfiller-chip--right");
        chip.classList.remove("innfiller-chip--left");
      } else {
        // Правый край чипа = левый край поля − отступ; раскрытие растёт влево.
        chip.style.right = vw - r.left + GAP_INPUT + "px";
        chip.style.left = "auto";
        chip.classList.add("innfiller-chip--left");
        chip.classList.remove("innfiller-chip--right");
      }
    }
  }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0)
      return false;
    return true;
  }

  // --- Планировщик (rAF-coalescing) ---
  let scheduled = false;
  function flush() {
    scheduled = false;
    scan();
    relayout();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  }

  // --- Наблюдатели ---
  const mo = new MutationObserver(schedule);
  mo.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("scroll", schedule, { passive: true, capture: true });
  window.addEventListener("resize", schedule, { passive: true });

  // Первичный проход — синхронно, чтобы чипы появились сразу, даже если
  // requestAnimationFrame ещё не сработал или приторможен (фоновые вкладки).
  scan();
  relayout();

  // Периодическая подстраховка для SPA/анимаций layout и фоновых вкладок,
  // где rAF может быть приостановлен. Работает напрямую, минуя rAF.
  setInterval(() => {
    scan();
    relayout();
  }, 1500);
})();
