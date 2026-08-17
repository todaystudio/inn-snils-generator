/*
 * Content script: авто-определение полей и кнопка-вставка рядом.
 *
 * Грузится ТОЛЬКО на сайтах, добавленных пользователем (динамическая регистрация
 * из background/sw.js). Здесь — поиск полей по name/id/placeholder/label,
 * плавающие чипы («Заполнить» / ФЛ·ЮЛ), вставка значения с учётом
 * React/Vue (нативный setter + события input/change).
 *
 * Значения берутся из согласованного профиля страницы (RusID.getProfile):
 * одна страница = одно лицо, один банк, одна организация, один адрес.
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
  const ALLOWED_TYPES = new Set(["text", "tel", "number", "search", "email", "", undefined, null]);

  // --- Геометрия ---
  const ICON = 24; // диаметр круглой иконки
  const GAP_INPUT = 6; // отступ чипа от внешнего края поля
  const GAP_INNER = 5; // зазор между иконкой и кнопками ФЛ/ЮЛ / подписью
  const EXPAND_W = 76; // ширина раскрытого блока ФЛ/ЮЛ
  const LABEL_W = 96; // ширина подписи «Заполнить»
  const VP_MARGIN = 12; // запас, чтобы считать поле «во вьюпорте»

  // --- Подписи и подсказки по типам полей ---
  const KIND_TITLES = {
    snils: "Вставить СНИЛС",
    innKpp: "Вставить ИНН/КПП организации",
    innBank: "Вставить ИНН банка (10 цифр)",
    bik: "Вставить БИК банка",
    ks: "Вставить корреспондентский счёт (20 цифр)",
    rs: "Вставить расчётный счёт (20 цифр)",
    kpp: "Вставить КПП (9 цифр)",
    ogrn: "Вставить ОГРН (13 цифр)",
    ogrnip: "Вставить ОГРНИП (15 цифр)",
    okpo: "Вставить ОКПО",
    oktmo: "Вставить ОКТМО",
    okved: "Вставить код ОКВЭД",
    bankName: "Вставить название банка",
    companyName: "Вставить наименование организации",
    fio: "Вставить ФИО",
    surname: "Вставить фамилию",
    firstName: "Вставить имя",
    patronymic: "Вставить отчество",
    city: "Вставить город",
    region: "Вставить регион",
    street: "Вставить улицу",
    house: "Вставить дом",
    apartment: "Вставить квартиру",
    zip: "Вставить почтовый индекс",
    address: "Вставить адрес",
    email: "Вставить e-mail",
    phone: "Вставить телефон",
    passportSeries: "Вставить серию паспорта",
    passportNumber: "Вставить номер паспорта",
    passportCode: "Вставить код подразделения",
    passportIssuer: "Вставить, кем выдан паспорт",
    passport: "Вставить серию и номер паспорта",
  };

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

  // Правила распознавания: [регэксп на сигнатуру поля, тип]. Порядок важен —
  // от частных к общим (например, «ИНН банка» раньше «ИНН», «к/с» раньше «счёт»).
  const CARD_RE = /карт|card|iban|swift|cvv|cvc/;
  const RULES = [
    [/снилс|\bsnils\b/, "snils"],
    [/инн[^]{0,12}банк|банк[^]{0,12}инн/, "innBank"],
    [/инн[^]{0,6}кпп|кпп[^]{0,6}инн/, "innKpp"],
    [/инн|\binn\b|\btax_?id\b|\btaxpayer\b/, "inn"],
    [/корреспондент|корсч[её]т|к\s*\/\s*с|(^|\s)кс(\s|$)|\bks\b|corr(espondent)?/, "ks"],
    [/расч[её]тн|р\s*\/\s*с|\brs\b|settlement/, "rs"],
    [/сч[её]т|account/, "rs"],
    [/бик|\bbik\b/, "bik"],
    [/кпп|\bkpp\b/, "kpp"],
    [/огрнип|\bogrnip\b/, "ogrnip"],
    [/огрн|\bogrn\b/, "ogrn"],
    [/окпо|\bokpo\b/, "okpo"],
    [/октмо|\boktmo\b/, "oktmo"],
    [/оквэд|\bokved\b/, "okved"],
    [/наименован[^]{0,24}банк|назван[^]{0,24}банк|банк[^]{0,24}(наименован|названи)|банк[^]{0,12}получател|получател[^]{0,12}банк|(^|\s)банк(а|е)?(\s|$)|bank\s*name/, "bankName"],
    [/e-?mail|имейл|емейл|электронн[^]{0,24}почт|\bmail\b/, "email"],
    [/телефон|phone|\btel\b|мобильн|сотов|домашн|факс/, "phone"],
    [/фио|ф\s*\.\s*и\s*\.\s*о|full\s*name/, "fio"],
    [/фамил|surname|last\s*name|family\s*name/, "surname"],
    [/отчеств|patronym|middle\s*name/, "patronymic"],
    [/имя|\bname\b|first\s*name|given\s*name/, "firstName"],
    // Адрес: сначала частные поля, общий «адрес» — последним, иначе id вроде
    // "main_address.Registration.region" перехватывает правило целиком.
    [/место\s*рожден|birth\s*place/, "city"],
    [/город|\bcity\b|\btown\b|насел[её]нн/, "city"],
    [/регион|област|субъект|республик|(^|\s)край(\s|$)|округ/, "region"],
    [/район|district/, null], // район — не городской адрес, не заполняем
    [/улиц|проспект|просп\.|пр-кт|бульвар|переулок|шоссе|набережн|проезд|\bstreet\b/, "street"],
    [/строение|корпус|здание|house|building|(^|[^а-яё])дом([^еи]|$)/, "house"],
    [/квартир|помещен|\bflat\b|\bapart|\bunit\b/, "apartment"],
    [/индекс|\bzip\b|postal(\s*code)?/, "zip"],
    [/адрес|address/, "address"],
    // Паспорт: комбинированные и контекстные правила раньше общих.
    [/серия[^]{0,16}номер|номер[^]{0,16}серия/, "passport"],
    [/номер[^]{0,12}паспорт|паспорт[^]{0,12}номер|passport.{0,8}num/, "passportNumber"],
    [/серия/, "passportSeries"],
    [/код[^]{0,8}подразделен|подразделен|passport.{0,8}code/, "passportCode"],
    [/кем\s*выдан|passport.{0,8}issuer/, "passportIssuer"],
    [/паспорт|passport/, "passport"],
    [/наименование|организац|компани|предприят|юр[.\s]*лиц|получател|фирм|контрагент|organization|company/, "companyName"],
  ];
  // Правила для полей банковских карт не применяем — это вне сценария
  // тестовых реквизитов (номер карты, БИН и т.п.).

  function detectKind(signal) {
    if (!signal) return null;
    const isCard = CARD_RE.test(signal);
    for (const [re, kind] of RULES) {
      if (!re.test(signal)) continue;
      // «Банк» в сигнатуре карточных полей («банковская карта») не считается
      if (kind === "bankName" && isCard) continue;
      if (isCard && kind !== "snils") return null; // карточные поля не заполняем
      return kind;
    }
    return null;
  }

  // Вариант контекста: банковские поля vs обычные, ИП vs ЮЛ, дом без корпуса.
  function detectVariant(signal) {
    return {
      bank: /банк|филиал/.test(signal),
      ip: /(^|\s)ип(\s|$)|индивидуальн\s*предпринимател/.test(signal),
      housePlain: /строение|корпус|здание/.test(signal),
    };
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

  function valueFor(kind, variant) {
    if (!RusID.fill) return null;
    if (kind === "inn") return null; // обрабатывается кнопками ФЛ/ЮЛ отдельно
    return RusID.fill(kind, variant);
  }

  // --- Создание чипа ---
  // «inn» — раскрывающийся чип с кнопками ФЛ/ЮЛ, остальные — пилюля «Заполнить».
  function buildChip(kind) {
    const root = document.createElement("div");
    root.className = "innfiller-chip innfiller-chip--" + kind;

    if (kind === "inn") {
      root.classList.add("innfiller-chip--inn");
      root.setAttribute("role", "group");
      root.setAttribute("aria-label", "Вставить ИНН");

      const expand = document.createElement("div");
      expand.className = "innfiller-chip__expand";

      const fl = document.createElement("button");
      fl.type = "button";
      fl.className = "innfiller-sub";
      fl.dataset.kind = "fl";
      fl.title = "ИНН физического лица / ИП — 12 цифр";
      fl.textContent = "ФЛ";

      const ul = document.createElement("button");
      ul.type = "button";
      ul.className = "innfiller-sub";
      ul.dataset.kind = "ul";
      ul.title = "ИНН юридического лица — 10 цифр";
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
          insertInto(b, b.dataset.kind === "fl" ? "innFl" : "innUl");
        })
      );

      root.appendChild(expand);
      root.appendChild(main);
      return root;
    }

    // Однокнопочный чип «Заполнить».
    root.classList.add("innfiller-chip--single");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "innfiller-chip__main innfiller-chip__main--btn";
    btn.title = KIND_TITLES[kind] || "Заполнить";
    btn.setAttribute("aria-label", KIND_TITLES[kind] || "Заполнить");
    btn.innerHTML =
      '<span class="innfiller-icon">' + SPARKLE_SVG + "</span>" +
      '<span class="innfiller-icon innfiller-icon--ok">' + CHECK_SVG + "</span>" +
      '<span class="innfiller-chip__label">Заполнить</span>';
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      insertInto(btn, kind);
    });
    root.appendChild(btn);
    return root;
  }

  function insertInto(btn, kind) {
    const chip = btn.closest(".innfiller-chip");
    const input = chip.__innfillerInput;
    const variant = Object.assign({}, chip.__innfillerVariant);
    if (!input) return;
    // maxLength поля (0 = не задан/велик) — генератор подберёт компактный формат
    const ml = input.maxLength;
    if (ml > 0 && ml < 100) variant.maxLen = ml;
    const value = valueFor(kind, variant);
    if (value === null || value === undefined) return;
    setValue(input, String(value));
    flashDone(chip);
  }

  // --- «Заполнить все»: одна кнопка на все найденные поля страницы ---
  // Для полей ИНН формат выбирается по контексту: если на форме есть
  // реквизиты организации (ОГРН, БИК, счёт…) — ЮЛ, иначе ФЛ.
  const COMPANY_KINDS = new Set([
    "ogrn", "ogrnip", "bik", "ks", "rs", "okpo", "oktmo", "okved",
    "companyName", "innBank", "innKpp", "kpp", "bankName",
  ]);

  function fillAll() {
    let preferUl = false;
    for (const input of tracked.keys()) {
      if (COMPANY_KINDS.has(input.dataset.innfiller)) {
        preferUl = true;
        break;
      }
    }
    let filled = 0;
    for (const [input, chip] of tracked) {
      if (!document.documentElement.contains(input)) continue;
      if (input.disabled || input.readOnly) continue;
      const kind = input.dataset.innfiller;
      const fillKind = kind === "inn" ? (preferUl ? "innUl" : "innFl") : kind;
      const variant = Object.assign({}, chip.__innfillerVariant);
      const ml = input.maxLength;
      if (ml > 0 && ml < 100) variant.maxLen = ml;
      const value = RusID.fill ? RusID.fill(fillKind, variant) : null;
      if (value === null || value === undefined) continue;
      setValue(input, String(value));
      flashDone(chip);
      filled++;
    }
    return filled;
  }

  let fillAllTimer = null;

  function buildFillAll() {
    const root = document.createElement("div");
    root.className = "innfiller-fillall";
    root.style.display = "none";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "innfiller-fillall__btn";
    btn.title = "Заполнить все найденные поля страницы";
    btn.setAttribute("aria-label", "Заполнить все найденные поля страницы");
    btn.innerHTML =
      '<span class="innfiller-icon">' + SPARKLE_SVG + "</span>" +
      '<span class="innfiller-icon innfiller-icon--ok">' + CHECK_SVG + "</span>" +
      '<span class="innfiller-fillall__label">Заполнить все · <span class="innfiller-fillall__count">0</span></span>' +
      '<span class="innfiller-fillall__done-label"></span>';

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const filled = fillAll();
      if (!filled) return;
      root.classList.add("is-done");
      root.querySelector(".innfiller-fillall__done-label").textContent =
        "Заполнено: " + filled;
      window.clearTimeout(fillAllTimer);
      fillAllTimer = window.setTimeout(() => root.classList.remove("is-done"), 1400);
    });

    root.appendChild(btn);
    return root;
  }

  const fillAllRoot = buildFillAll();
  document.body.appendChild(fillAllRoot);

  function updateFillAll() {
    // Кнопка видна, только если на странице есть распознанные поля.
    let live = 0;
    for (const input of tracked.keys()) {
      if (document.documentElement.contains(input) && !input.disabled && !input.readOnly) live++;
    }
    fillAllRoot.style.display = live > 0 ? "" : "none";
    fillAllRoot.querySelector(".innfiller-fillall__count").textContent = String(live);
  }

  function flashDone(chip) {
    chip.classList.add("is-done");
    window.setTimeout(() => chip.classList.remove("is-done"), 900);
  }

  // --- Реестр отслеживаемых полей ---
  const tracked = new Map(); // input -> chip

  function attachChip(input, kind, variant) {
    input.dataset.innfiller = kind; // маркер, чтобы не обработать повторно
    const chip = buildChip(kind);
    chip.__innfillerInput = input;
    chip.__innfillerVariant = variant;
    chip.style.display = "none"; // скрыт до первого позиционирования в relayout
    document.body.appendChild(chip);

    // Раскрытие по фокусу на поле (клавиатура + надёжность при blur→click).
    input.addEventListener("focus", () => chip.classList.add("is-open"));
    input.addEventListener("blur", () => {
      // Небольшая задержка, чтобы клик по кнопке успел сработать после blur.
      setTimeout(() => {
        if (!chip.matches(":hover")) chip.classList.remove("is-open");
      }, 150);
    });

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
      const signal = fieldSignal(input);
      const kind = detectKind(signal);
      if (!kind) continue;
      attachChip(input, kind, detectVariant(signal));
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

      // Сколько места нужно снаружи поля с учётом раскрытия.
      const isSingle = chip.classList.contains("innfiller-chip--single");
      const need = isSingle
        ? ICON + GAP_INNER + LABEL_W + GAP_INPUT
        : ICON + GAP_INNER + EXPAND_W + GAP_INPUT;
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
    updateFillAll();
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
  updateFillAll();

  // Периодическая подстраховка для SPA/анимаций layout и фоновых вкладок,
  // где rAF может быть приостановлен. Работает напрямую, минуя rAF.
  setInterval(() => {
    scan();
    relayout();
    updateFillAll();
  }, 1500);
})();
