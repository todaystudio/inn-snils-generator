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
    website: "Вставить сайт (URL)",
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
    [/сайт|website|web-?site|(^|[^a-z])url($|[^a-z])|https?:\/\//, "website"],
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

  function isCandidate(el) {
    const isInput = el instanceof HTMLInputElement;
    const isArea = el instanceof HTMLTextAreaElement;
    if (!isInput && !isArea) return false;
    if (el.disabled || el.readOnly) return false;
    if (isInput) {
      const t = (el.type || "").toLowerCase();
      return ALLOWED_TYPES.has(t);
    }
    return true; // textarea — всегда текстовое поле
  }

  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // --- Вставка значения (совместимо с React/Vue/Angular) ---
  function setValue(field, value) {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    try {
      field.focus();
      field.select();
    } catch (_) {
      /* some fields don't support select() */
    }
  }

  function valueFor(kind, variant) {
    if (!RusID.fill) return null;
    if (kind === "inn") return null; // обрабатывается кнопками ФЛ/ЮЛ отдельно
    return RusID.fill(kind, variant);
  }

  // ============================================================
  // Кастомные поля: правила пользователя (chrome.storage.local).
  // { id, host, selector, type, script, label }
  // type — один из известных видов заполнения или "script".
  // ============================================================

  // Виды данных для диалога настройки (совпадают с RusID.fill).
  const CUSTOM_TYPES = [
    ["script", "Свой скрипт…"],
    ["innFl", "ИНН физлица"],
    ["innUl", "ИНН юрлица"],
    ["snils", "СНИЛС"],
    ["innKpp", "ИНН/КПП"],
    ["bik", "БИК"],
    ["rs", "Расчётный счёт"],
    ["ks", "Корреспондентский счёт"],
    ["innBank", "ИНН банка"],
    ["kpp", "КПП"],
    ["ogrn", "ОГРН"],
    ["ogrnip", "ОГРНИП"],
    ["okpo", "ОКПО"],
    ["oktmo", "ОКТМО"],
    ["okved", "ОКВЭД"],
    ["bankName", "Название банка"],
    ["companyName", "Наименование организации"],
    ["website", "Сайт (URL)"],
    ["fio", "ФИО"],
    ["surname", "Фамилия"],
    ["firstName", "Имя"],
    ["patronymic", "Отчество"],
    ["city", "Город"],
    ["region", "Регион"],
    ["street", "Улица"],
    ["house", "Дом"],
    ["apartment", "Квартира"],
    ["zip", "Индекс"],
    ["address", "Адрес одной строкой"],
    ["email", "E-mail"],
    ["phone", "Телефон"],
    ["passportSeries", "Паспорт: серия"],
    ["passportNumber", "Паспорт: номер"],
    ["passportCode", "Паспорт: код подразделения"],
    ["passportIssuer", "Паспорт: кем выдан"],
    ["passport", "Паспорт: серия + номер"],
  ];

  let customRules = []; // правила текущего хоста
  let rulesLoaded = false;

  async function loadRules() {
    rulesLoaded = true;
    try {
      const got = await chrome.storage.local.get({ customRules: [] });
      const list = Array.isArray(got.customRules) ? got.customRules : [];
      customRules = list.filter(
        (r) => r && r.host === location.host && typeof r.selector === "string" && r.selector
      );
    } catch (_) {
      customRules = []; // chrome.storage недоступен — кастомных полей нет
    }
  }

  function ruleForInput(input) {
    for (const rule of customRules) {
      let els = null;
      try {
        els = document.querySelectorAll(rule.selector);
      } catch (_) {
        continue;
      }
      if (els && Array.prototype.includes.call(els, input)) return rule;
    }
    return null;
  }

  async function saveRule(rule) {
    const got = await chrome.storage.local.get({ customRules: [] });
    const list = Array.isArray(got.customRules) ? got.customRules : [];
    const i = list.findIndex((r) => r.id === rule.id);
    if (i >= 0) list[i] = rule;
    else list.push(rule);
    await chrome.storage.local.set({ customRules: list });
  }

  async function deleteRule(id) {
    const got = await chrome.storage.local.get({ customRules: [] });
    const list = (Array.isArray(got.customRules) ? got.customRules : []).filter((r) => r.id !== id);
    await chrome.storage.local.set({ customRules: list });
  }

  // Поддерживает ли окружение компиляцию строк (строгий CSP страницы её запрещает).
  let evalSupported = null;
  function checkEval() {
    if (evalSupported !== null) return evalSupported;
    try {
      // eslint-disable-next-line no-new-func
      new Function("return 1")();
      evalSupported = true;
    } catch (_) {
      evalSupported = false;
    }
    return evalSupported;
  }

  const scriptCache = new Map(); // код -> функция

  function compileUserScript(code) {
    if (scriptCache.has(code)) return scriptCache.get(code);
    // Тело с return — как есть; иначе считаем выражением.
    const body = /\breturn\b/.test(code) ? code : "return (" + code + ");";
    const fn = new Function("ctx", "RusID", '"use strict";\n' + body);
    scriptCache.set(code, fn);
    return fn;
  }

  function scriptContext(rule, input) {
    return {
      host: location.host,
      selector: rule ? rule.selector : "",
      label: rule ? rule.label || "" : "",
      field: {
        id: input ? input.id : "",
        name: input ? input.name : "",
        type: input ? input.type : "",
        placeholder: input ? input.placeholder : "",
        value: input ? input.value : "",
      },
    };
  }

  // Значение для кастомного поля; бросает исключение наружу при ошибке скрипта.
  function customValueFor(rule, input) {
    if (rule.type === "script") {
      const fn = compileUserScript(rule.script || "");
      const out = fn(scriptContext(rule, input), RusID);
      if (out === undefined || out === null) return null;
      return String(out);
    }
    const ml = input && input.maxLength;
    const opts = ml > 0 && ml < 100 ? { maxLen: ml } : {};
    return RusID.fill ? RusID.fill(rule.type, opts) : null;
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
    let value;
    if (kind === "custom") {
      // Ошибки пользовательского скрипта не должны ломать страницу.
      try {
        value = customValueFor(variant.customRule, input);
      } catch (err) {
        console.warn("[inn-filler] ошибка пользовательского скрипта:", err);
        return;
      }
    } else {
      // maxLength поля (0 = не задан/велик) — генератор подберёт компактный формат
      const ml = input.maxLength;
      if (ml > 0 && ml < 100) variant.maxLen = ml;
      value = valueFor(kind, variant);
    }
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
      let value = null;
      if (kind === "custom") {
        try {
          value = customValueFor(chip.__innfillerVariant.customRule, input);
        } catch (err) {
          console.warn("[inn-filler] ошибка пользовательского скрипта:", err);
        }
      } else {
        const fillKind = kind === "inn" ? (preferUl ? "innUl" : "innFl") : kind;
        const variant = Object.assign({}, chip.__innfillerVariant);
        const ml = input.maxLength;
        if (ml > 0 && ml < 100) variant.maxLen = ml;
        value = RusID.fill ? RusID.fill(fillKind, variant) : null;
      }
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
    root.style.display = "none"; // до первого updateFillAll

    // «+»: научить расширение заполнять нераспознанное поле.
    const add = document.createElement("button");
    add.type = "button";
    add.className = "innfiller-fillall__add";
    add.title = "Добавить своё поле: научить расширение заполнять нераспознанное поле";
    add.setAttribute("aria-label", "Добавить своё поле");
    add.textContent = "+";
    add.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeFieldDialog();
      startPicking();
    });

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

    root.appendChild(add);
    root.appendChild(btn);
    return root;
  }

  const fillAllRoot = buildFillAll();
  document.body.appendChild(fillAllRoot);

  function updateFillAll() {
    // «+» доступен всегда (через него добавляются кастомные поля),
    // сама кнопка заполнения — только когда есть найденные поля.
    let live = 0;
    for (const input of tracked.keys()) {
      if (document.documentElement.contains(input) && !input.disabled && !input.readOnly) live++;
    }
    fillAllRoot.style.display = "";
    fillAllRoot.querySelector(".innfiller-fillall__btn").style.display = live > 0 ? "" : "none";
    fillAllRoot.querySelector(".innfiller-fillall__count").textContent = String(live);
  }

  // --- Режим выбора поля: клик по любому input открывает диалог настройки ---
  let picking = false;
  let pickBar = null;

  function startPicking() {
    if (picking) return;
    picking = true;
    pickBar = document.createElement("div");
    pickBar.className = "innfiller-pickbar";
    pickBar.textContent = "Кликните по полю, которое хотите настроить · Esc — отмена";
    document.body.appendChild(pickBar);
    document.addEventListener("mouseover", pickHover, true);
    document.addEventListener("mouseout", pickUnhover, true);
    document.addEventListener("click", pickClick, true);
    document.addEventListener("keydown", pickKey, true);
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    if (pickBar) pickBar.remove();
    pickBar = null;
    document.removeEventListener("mouseover", pickHover, true);
    document.removeEventListener("mouseout", pickUnhover, true);
    document.removeEventListener("click", pickClick, true);
    document.removeEventListener("keydown", pickKey, true);
  }

  function pickHover(e) {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) t.classList.add("innfiller-pick-hover");
  }
  function pickUnhover(e) {
    const t = e.target;
    if (t && t.classList) t.classList.remove("innfiller-pick-hover");
  }
  function pickClick(e) {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
      e.preventDefault();
      e.stopPropagation();
      t.classList.remove("innfiller-pick-hover");
      stopPicking();
      openFieldDialog(t, ruleForInput(t));
    }
  }
  function pickKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stopPicking();
    }
  }

  // --- Диалог настройки кастомного поля ---
  // Уникальный селектор для выбранного поля (id → name → nth-of-type путь).
  function selectorFor(input) {
    if (input.id) {
      const byId = "#" + cssEscape(input.id);
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch (_) { /* id с экзотическими символами */ }
    }
    if (input.name) {
      const byName = input.tagName.toLowerCase() + "[name=" + JSON.stringify(input.name) + "]";
      try {
        const same = Array.prototype.filter.call(
          document.querySelectorAll(byName), (i) => i.type === input.type);
        if (same.length === 1) return byName;
      } catch (_) { /* unreachable */ }
    }
    let el = input;
    const parts = [];
    while (el && el !== document.body && parts.length < 6) {
      const parent = el.parentElement;
      if (!parent) break;
      const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName);
      parts.unshift(el.tagName.toLowerCase() + ":nth-of-type(" + (same.indexOf(el) + 1) + ")");
      el = parent;
    }
    return parts.join(" > ");
  }

  let cfgDialog = null;

  function closeFieldDialog() {
    if (cfgDialog) {
      cfgDialog.remove();
      cfgDialog = null;
    }
  }

  function fieldDescription(input) {
    const bits = ["<" + input.tagName.toLowerCase() + " type=" + JSON.stringify(input.type || "text") + ">"];
    if (input.id) bits.push("id=" + JSON.stringify(input.id));
    if (input.name) bits.push("name=" + JSON.stringify(input.name));
    if (input.placeholder) bits.push("placeholder=" + JSON.stringify(input.placeholder));
    const lab = labelTextFor(input);
    if (lab) bits.push("подпись=" + JSON.stringify(lab.trim().slice(0, 40)));
    return bits.join(" · ");
  }

  function openFieldDialog(input, existingRule) {
    closeFieldDialog();
    const rule = existingRule || {
      id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      host: location.host,
      selector: selectorFor(input),
      type: "script",
      script: "return 'значение-' + Math.floor(Math.random() * 1000);",
      label: (labelTextFor(input) || input.placeholder || input.name || input.id || "поле").trim().slice(0, 40),
    };

    const root = document.createElement("div");
    root.className = "innfiller-cfg";
    const markUi = (el) => { el.dataset.innfiller = "ui"; return el; };

    // --- разметка ---
    const card = document.createElement("div");
    card.className = "innfiller-cfg__card";

    const head = document.createElement("div");
    head.className = "innfiller-cfg__head";
    head.innerHTML = '<span class="innfiller-cfg__title">' +
      (existingRule ? "Настроить поле" : "Новое кастомное поле") + "</span>";
    const closeBtn = markUi(document.createElement("button"));
    closeBtn.type = "button";
    closeBtn.className = "innfiller-cfg__close";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Закрыть");
    head.appendChild(closeBtn);

    const info = document.createElement("div");
    info.className = "innfiller-cfg__info";
    info.textContent = fieldDescription(input);

    const selLabel = document.createElement("label");
    selLabel.className = "innfiller-cfg__label";
    selLabel.textContent = "CSS-селектор поля";
    const selInput = markUi(document.createElement("input"));
    selInput.type = "text";
    selInput.className = "innfiller-cfg__input";
    selInput.value = rule.selector;

    const typeLabel = document.createElement("label");
    typeLabel.className = "innfiller-cfg__label";
    typeLabel.textContent = "Чем заполнять";
    const typeSelect = markUi(document.createElement("select"));
    typeSelect.className = "innfiller-cfg__input";
    for (const [value, label] of CUSTOM_TYPES) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      typeSelect.appendChild(opt);
    }
    typeSelect.value = CUSTOM_TYPES.some((t) => t[0] === rule.type) ? rule.type : "script";

    const scriptWrap = document.createElement("div");
    scriptWrap.className = "innfiller-cfg__script";
    const scriptLabel = document.createElement("label");
    scriptLabel.className = "innfiller-cfg__label";
    scriptLabel.textContent = "Скрипт (тело функции; return — результат)";
    const scriptArea = markUi(document.createElement("textarea"));
    scriptArea.className = "innfiller-cfg__input innfiller-cfg__script-area";
    scriptArea.rows = 4;
    scriptArea.spellcheck = false;
    scriptArea.value = rule.script || "";
    const scriptHint = document.createElement("div");
    scriptHint.className = "innfiller-cfg__hint";
    scriptHint.textContent = "Доступно: ctx.host, ctx.field (id, name, placeholder, value), " +
      "ctx.selector и RusID — генераторы расширения, например RusID.fill('bik').";
    const testRow = document.createElement("div");
    testRow.className = "innfiller-cfg__row";
    const testBtn = markUi(document.createElement("button"));
    testBtn.type = "button";
    testBtn.className = "innfiller-cfg__btn innfiller-cfg__btn--ghost";
    testBtn.textContent = "Проверить";
    const testOut = document.createElement("span");
    testOut.className = "innfiller-cfg__test";
    testRow.appendChild(testBtn);
    testRow.appendChild(testOut);
    scriptWrap.appendChild(scriptLabel);
    scriptWrap.appendChild(scriptArea);
    scriptWrap.appendChild(scriptHint);
    scriptWrap.appendChild(testRow);

    const cspWarn = document.createElement("div");
    cspWarn.className = "innfiller-cfg__warn";
    cspWarn.hidden = true;
    cspWarn.textContent = "CSP этой страницы запрещает выполнение скриптов — выберите готовый тип данных.";

    const errLine = document.createElement("div");
    errLine.className = "innfiller-cfg__error";
    errLine.hidden = true;

    const foot = document.createElement("div");
    foot.className = "innfiller-cfg__foot";
    const saveBtn = markUi(document.createElement("button"));
    saveBtn.type = "button";
    saveBtn.className = "innfiller-cfg__btn innfiller-cfg__btn--primary";
    saveBtn.textContent = "Сохранить";
    const delBtn = markUi(document.createElement("button"));
    delBtn.type = "button";
    delBtn.className = "innfiller-cfg__btn innfiller-cfg__btn--danger";
    delBtn.textContent = "Удалить правило";
    if (!existingRule) delBtn.style.display = "none";
    const cancelBtn = markUi(document.createElement("button"));
    cancelBtn.type = "button";
    cancelBtn.className = "innfiller-cfg__btn innfiller-cfg__btn--ghost";
    cancelBtn.textContent = "Отмена";
    foot.appendChild(saveBtn);
    if (existingRule) foot.appendChild(delBtn);
    foot.appendChild(cancelBtn);

    card.appendChild(head);
    card.appendChild(info);
    card.appendChild(selLabel);
    card.appendChild(selInput);
    card.appendChild(typeLabel);
    card.appendChild(typeSelect);
    card.appendChild(scriptWrap);
    card.appendChild(cspWarn);
    card.appendChild(errLine);
    card.appendChild(foot);
    root.appendChild(card);
    document.body.appendChild(root);
    cfgDialog = root;

    // --- поведение ---
    const syncScriptVisibility = () => {
      const isScript = typeSelect.value === "script";
      scriptWrap.style.display = isScript ? "" : "none";
      cspWarn.hidden = !(isScript && !checkEval());
    };
    typeSelect.addEventListener("change", syncScriptVisibility);
    syncScriptVisibility();

    const showErr = (msg) => {
      errLine.textContent = msg;
      errLine.hidden = false;
    };
    const hideErr = () => { errLine.hidden = true; };

    const buildRule = () => ({
      id: rule.id,
      host: location.host,
      selector: selInput.value.trim(),
      type: typeSelect.value,
      script: scriptArea.value,
      label: rule.label,
    });

    testBtn.addEventListener("click", () => {
      hideErr();
      testOut.textContent = "";
      const current = buildRule();
      if (current.type !== "script") {
        const v = RusID.fill ? RusID.fill(current.type, {}) : null;
        testOut.textContent = v === null || v === undefined ? "нет значения" : String(v);
        return;
      }
      if (!checkEval()) {
        showErr("CSP страницы запрещает eval — скрипт здесь не выполнится.");
        return;
      }
      try {
        const out = customValueFor(current, input);
        testOut.textContent = out === null || out === undefined ? "нет значения" : String(out);
      } catch (err) {
        showErr("Ошибка скрипта: " + (err && err.message ? err.message : err));
      }
    });

    const save = async () => {
      hideErr();
      const current = buildRule();
      if (!current.selector) {
        showErr("Укажите CSS-селектор.");
        return;
      }
      try {
        if (document.querySelectorAll(current.selector).length === 0) {
          showErr("Селектор ничего не находит на этой странице.");
          return;
        }
      } catch (_) {
        showErr("Некорректный CSS-селектор.");
        return;
      }
      if (current.type === "script") {
        if (!checkEval()) {
          showErr("CSP страницы запрещает eval — выберите готовый тип данных.");
          return;
        }
        try {
          compileUserScript(current.script || "");
        } catch (err) {
          showErr("Скрипт не компилируется: " + (err && err.message ? err.message : err));
          return;
        }
      }
      try {
        await saveRule(current);
        closeFieldDialog();
      } catch (err) {
        showErr("Не удалось сохранить: " + (err && err.message ? err.message : err));
      }
    };

    saveBtn.addEventListener("click", save);
    delBtn.addEventListener("click", async () => {
      try {
        await deleteRule(rule.id);
      } catch (_) { /* правило уже удалено */ }
      closeFieldDialog();
    });
    cancelBtn.addEventListener("click", closeFieldDialog);
    closeBtn.addEventListener("click", closeFieldDialog);
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeFieldDialog();
      }
    });
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
  function applyCustomRules() {
    for (const rule of customRules) {
      let els;
      try {
        els = document.querySelectorAll(rule.selector);
      } catch (_) {
        continue; // битой селектор — пропускаем
      }
      for (let i = 0; i < els.length; i++) {
        const input = els[i];
        if (tracked.has(input)) continue;
        if (input.dataset.innfiller) continue;
        if (!isCandidate(input)) continue;
        // Кастомное правило приоритетнее авто-определения: помечаем поле первым.
        attachChip(input, "custom", { customRule: rule });
        const btn = tracked.get(input)?.querySelector(".innfiller-chip__main--btn");
        if (btn) {
          const typeLabel = (CUSTOM_TYPES.find((t) => t[0] === rule.type) || [rule.type])[1];
          btn.title = "Заполнить: " + (rule.label || "кастомное поле") + " · " + typeLabel;
        }
      }
    }
  }

  function scan() {
    applyCustomRules();
    const fields = document.querySelectorAll("input, textarea");
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (tracked.has(field)) continue;
      if (field.dataset.innfiller) continue;
      if (!isCandidate(field)) continue;
      const signal = fieldSignal(field);
      const kind = detectKind(signal);
      if (!kind) continue;
      attachChip(field, kind, detectVariant(signal));
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

  // --- Кастомные правила: загрузка и живое обновление ---
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.customRules) return;
      // Снимаем кастомные чипы и пересканируем с новым набором правил.
      for (const [input, chip] of Array.from(tracked)) {
        if (input.dataset.innfiller === "custom") {
          chip.remove();
          tracked.delete(input);
          delete input.dataset.innfiller;
        }
      }
      loadRules().then(() => {
        scan();
        relayout();
        updateFillAll();
      });
    });
  }
  loadRules().then(() => schedule());

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
