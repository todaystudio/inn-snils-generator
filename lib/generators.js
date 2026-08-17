/*
 * Генерация корректных тестовых реквизитов РФ с контрольными числами.
 * Модуль самодостаточный: работает и в popup (через <script>), и в Node для тестов.
 *
 * Методики расчёта контрольных чисел:
 *  - ИНН юридического лица — 10 цифр, одна контрольная (приказ ФНС).
 *  - ИНН физического лица / ИП — 12 цифр, две контрольные.
 *  - СНИЛС — 9 порядковых цифр + 2 контрольные (методика ПФР).
 *  - ОГРН — 13 цифр, контрольная = младший разряд числа из первых 12 цифр mod 11.
 *  - ОГРНИП — 15 цифр, контрольная = младший разряд числа из первых 14 цифр mod 13.
 *  - ОКПО — 8/10 цифр, контрольная по остатку от деления взвешенной суммы на 11.
 *  - Р/с и к/с — 20 цифр, контрольный ключ по разряду 9 (положение ЦБ № 531-П):
 *    последние 3 цифры БИК (для к/с — «0» + разряды 5–6) + счёт, веса
 *    7,1,3…, сумма младших разрядов произведений кратна 10.
 *
 * Датасеты (имена, города, улицы…) — в lib/data.js, грузится до этого файла.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RusID = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // --- Датасеты ---
  let D = typeof globalThis !== "undefined" ? globalThis.RusIDData : null;
  if (!D && typeof require === "function") {
    try {
      D = require("./data.js");
    } catch (_) {
      /* датасеты не подключены — работают только базовые генераторы */
    }
  }

  // --- Коэффициенты контрольных сумм ---
  const COEFF_INN10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const COEFF_INN12_1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  const COEFF_INN12_2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

  // Веса контрольного ключа счёта (положение ЦБ № 531-П, приложение 5).
  const KEY_WEIGHTS = [7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1];

  // Коды субъектов РФ, используемые как первые две цифры ИНН/ОГРН/БИК.
  const REGION_CODES = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
    79, 82, 83, 86, 87, 88, 89, 91, 92, 95, 99,
  ];

  // --- Вспомогательные функции ---
  const randInt = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  const pad = (n, len) => String(n).padStart(len, "0");

  const pick = (arr) => arr[randInt(0, arr.length - 1)];

  // Возвращает остаток от деления на 11 с приведением 10 -> 0 (правило ФНС).
  const checkDigit = (sum) => {
    const k = sum % 11;
    return k === 10 ? 0 : k;
  };

  const sumProducts = (digits, coeffs) =>
    digits.reduce((acc, d, i) => acc + d * coeffs[i], 0);

  const randomRegion = () => REGION_CODES[randInt(0, REGION_CODES.length - 1)];

  // --- Женские формы фамилий и отчеств ---
  function femaleSurname(surname) {
    if (/[иы]х$/.test(surname) || /ко$/.test(surname) || /ук$/.test(surname))
      return surname; // Скрых, Черных, Шевченко, Тимошук — не меняются
    if (/ский$/.test(surname)) return surname.slice(0, -2) + "ая";
    if (/цкий$/.test(surname)) return surname.slice(0, -2) + "ая";
    if (/ой$/.test(surname)) return surname.slice(0, -2) + "ая";
    if (/[оё]в$/.test(surname)) return surname + "а";
    if (/ев$/.test(surname)) return surname + "а";
    if (/ин$/.test(surname)) return surname + "а";
    if (/ын$/.test(surname)) return surname + "а";
    return surname;
  }

  function femalePatronymic(patronymic) {
    if (D && Object.prototype.hasOwnProperty.call(D.PATRONYMICS_F_IRREGULAR, patronymic))
      return D.PATRONYMICS_F_IRREGULAR[patronymic];
    if (/ович$/.test(patronymic)) return patronymic.slice(0, -4) + "овна";
    if (/евич$/.test(patronymic)) return patronymic.slice(0, -4) + "евна";
    if (/ич$/.test(patronymic)) return patronymic + "на";
    return patronymic;
  }

  // --- Транслитерация для e-mail ---
  const TRANSLIT = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh",
    з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
    п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
    ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
    я: "ya",
  };
  const translit = (s) =>
    s.toLowerCase().split("").map((ch) => TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch).join("");

  // --- ИНН юридического лица (10 цифр) ---
  // ИП — это физическое лицо, поэтому у ИП 12-значный ИНН (как у ФЛ).
  function generateInnUl(region) {
    const reg = pad(region !== undefined ? region : randomRegion(), 2);
    const body = pad(randInt(0, 9999999), 7); // 7 случайных цифр + 2 региона = 9
    const digits = (reg + body).split("").map(Number);
    const k10 = checkDigit(sumProducts(digits, COEFF_INN10));
    digits.push(k10);
    return digits.join("");
  }

  // --- ИНН физического лица и ИП (12 цифр) ---
  function generateInnFl(region) {
    const reg = pad(region !== undefined ? region : randomRegion(), 2);
    const body = pad(randInt(0, 99999999), 8); // 8 случайных + 2 региона = 10
    const digits = (reg + body).split("").map(Number);
    const k11 = checkDigit(sumProducts(digits, COEFF_INN12_1));
    digits.push(k11);
    const k12 = checkDigit(sumProducts(digits, COEFF_INN12_2));
    digits.push(k12);
    return digits.join("");
  }

  // ИП использует тот же формат, что и ФЛ (12 знаков).
  const generateInnIp = generateInnFl;

  // --- СНИЛС (XXX-XXX-XXX YY) ---
  // 9 порядковых цифр + 2 контрольные.
  function generateSnils() {
    const seq = pad(randInt(1, 999999998), 9).split("").map(Number);
    const sum = seq.reduce((acc, d, i) => acc + d * (9 - i), 0);
    let check;
    if (sum < 100) check = sum;
    else if (sum === 100) check = 0;
    else {
      check = sum % 101;
      if (check === 100) check = 0;
    }
    const digits = seq.join("") + pad(check, 2);
    return formatSnils(digits);
  }

  // --- БИК (9 цифр): 04 + регион + отделение + номер КО (500–999) ---
  function generateBik() {
    return (
      "04" +
      pad(randomRegion(), 2) +
      pad(randInt(0, 99), 2) +
      pad(randInt(500, 999), 3)
    );
  }

  // --- Контрольный ключ счёта (положение ЦБ № 531-П) ---
  // Для к/с (301…) ключевание по «0» + разряды 5–6 БИК, для остальных —
  // по последним 3 цифрам БИК. Ключ стоит в 9-м разряде счёта.
  function accountChecksumOk(bik, account) {
    const account20 = String(account).replace(/\D/g, "").padStart(20, "0");
    const prefix = /^301/.test(account20) ? "0" + bik.slice(4, 6) : bik.slice(-3);
    const chars = (prefix + account20).split("").map(Number);
    let sum = 0;
    for (let i = 0; i < chars.length; i++) sum += (chars[i] * KEY_WEIGHTS[i]) % 10;
    return sum % 10 === 0;
  }

  function withAccountKey(bik, accountSkeleton) {
    // accountSkeleton: 20 символов, 9-й разряд (index 8) будет подобран.
    const chars = accountSkeleton.split("");
    for (let k = 0; k <= 9; k++) {
      chars[8] = String(k);
      if (accountChecksumOk(bik, chars.join(""))) return chars.join("");
    }
    return accountSkeleton;
  }

  // --- Расчётный счёт: 5 балансовых + 810 (руб.) + ключ + 4 отдела + 7 номера ---
  function generateRs(bik, balance) {
    const skeleton =
      (balance || "40702") +
      "810" +
      "0" +
      bik.slice(-3) +
      String(randInt(0, 9)) +
      pad(randInt(0, 9999999), 7);
    return withAccountKey(bik, skeleton);
  }

  // --- Корреспондентский счёт: 30101 + 810 + ключ + разряды БИК ---
  function generateKs(bik) {
    const skeleton = "30101" + "810" + "0" + "00000000" + bik.slice(-3);
    return withAccountKey(bik, skeleton);
  }

  // --- КПП: 4 цифры налогового органа + 2 причины + 3 номера ---
  function generateKpp(region) {
    const reg = pad(region !== undefined ? region : randomRegion(), 2);
    const inspection = reg + pad(randInt(0, 99), 2);
    const reason = pick(D ? D.KPP_REASONS : ["01"]);
    const serial = Math.random() < 0.85 ? "001" : pad(randInt(1, 50), 3);
    return inspection + reason + serial;
  }

  // --- ОГРН (13 цифр, ЮЛ) и ОГРНИП (15 цифр, ИП) ---
  function generateOgrn(region) {
    const head =
      "1" + pad(randInt(0, 25), 2) + pad(region !== undefined ? region : randomRegion(), 2) +
      pad(randInt(0, 9999999), 7);
    const control = Number(head) % 11; // контрольная = младший разряд остатка
    return head + String(control % 10);
  }

  function generateOgrnip(region) {
    const head =
      "3" + pad(randInt(0, 25), 2) + pad(region !== undefined ? region : randomRegion(), 2) +
      pad(randInt(0, 999999999), 9);
    const control = Number(head) % 13;
    return head + String(control % 10);
  }

  // --- ОКПО: 8 цифр (ЮЛ) или 10 (ИП) ---
  function okpoCheckDigit(bodyDigits) {
    const calc = (offset) =>
      bodyDigits.reduce((s, d, i) => s + d * (i + offset + 1), 0) % 11;
    let control = calc(0);
    if (control === 10) control = calc(2); // веса 3,4,5…
    return control === 10 ? 0 : control;
  }

  function generateOkpo(len) {
    const n = len === 10 ? 10 : 8;
    const body = String(randInt(1, 9)) + pad(randInt(0, Math.pow(10, n - 2) - 1), n - 2);
    const digits = body.split("").map(Number);
    return body + String(okpoCheckDigit(digits));
  }

  // --- Названия банков и организаций ---
  function bankName() {
    if (!D) return "ПАО «Тестбанк»";
    const stem1 = pick(D.BANK_STEMS);
    const stem2 = pick(D.BANK_STEMS).toLowerCase();
    const name =
      Math.random() < 0.55 && stem1 !== stem2
        ? stem1 + stem2 + "банк"
        : stem1 + "банк";
    return pick(D.BANK_FORMS) + " «" + name + "»";
  }

  // Части названия компании — чтобы домен сайта был согласован с наименованием.
  function companyNameParts() {
    if (!D) return { form: "ООО", inner: "Тест" };
    const stem = pick(D.COMPANY_STEMS);
    const tail = pick(D.COMPANY_TAILS);
    const r = Math.random();
    const inner = r < 0.4 ? stem + " " + tail : r < 0.75 ? stem + tail : stem + "-" + tail;
    return { form: pick(D.COMPANY_FORMS), inner };
  }

  function companyName() {
    const p = companyNameParts();
    return p.form + " «" + p.inner + "»";
  }

  // Домен из названия: «Вектор Плюс» → vektor-plyus.ru
  function websiteFromInner(inner) {
    const slug =
      translit(String(inner).toLowerCase()).split(/[\s-]+/).filter(Boolean).join("-")
        .replace(/[^a-z0-9-]/g, "") || "company";
    return "https://" + slug + "." + pick(D ? D.SITE_TLDS : ["ru"]);
  }

  // --- Телефон, e-mail, паспорт ---
  function generatePhone() {
    const code = pick(D ? D.MOBILE_CODES : [999]);
    return (
      "+7 " + code + " " + pad(randInt(0, 999), 3) + "-" +
      pad(randInt(0, 99), 2) + "-" + pad(randInt(0, 99), 2)
    );
  }

  function generateEmail(person) {
    const domain = pick(D ? D.EMAIL_DOMAINS : ["example.com"]);
    const local = translit(person.surname) + "." + translit(person.name).charAt(0) +
      "." + randInt(10, 99);
    return local + "@" + domain;
  }

  function generatePassport(region) {
    return {
      series: pad(region !== undefined ? region : randomRegion(), 2) + pad(randInt(5, 25), 2),
      number: pad(randInt(100000, 999999), 6),
    };
  }

  // --- Согласованный профиль страницы ---
  // Одна страница = одно лицо, одна организация, один банк, один адрес:
  // значения во всех полях согласованы (регион ИНН = регион КПП = индекс,
  // к/с и р/с прошли ключевание по одному БИК и т.д.).
  let profileCache = null;

  function buildProfile() {
    const city = pick(D.CITIES);
    const gender = pick(["m", "f"]);
    const surnameM = pick(D.SURNAMES);
    const patronymicM = pick(D.PATRONYMICS);
    const phoneDigits =
      String(pick(D.MOBILE_CODES)) + pad(randInt(0, 999), 3) +
      pad(randInt(0, 99), 2) + pad(randInt(0, 99), 2);
    const person = {
      gender,
      surname: gender === "m" ? surnameM : femaleSurname(surnameM),
      name: pick(gender === "m" ? D.MALE_NAMES : D.FEMALE_NAMES),
      patronymic: gender === "m" ? patronymicM : femalePatronymic(patronymicM),
      innFl: generateInnFl(city.c),
      snils: generateSnils(),
      ogrnip: generateOgrnip(city.c),
      email: "",
      phoneDigits,
      phone:
        "+7 " + phoneDigits.slice(0, 3) + " " + phoneDigits.slice(3, 6) + "-" +
        phoneDigits.slice(6, 8) + "-" + phoneDigits.slice(8),
    };
    person.fio = person.surname + " " + person.name + " " + person.patronymic;
    person.email = generateEmail(person);
    const passport = generatePassport(city.c);
    person.passportSeries = passport.series;
    person.passportNumber = passport.number;
    person.passport = passport.series + " " + passport.number;
    person.passportCode =
      pad(randInt(0, 999), 3) + "-" + pad(randInt(0, 999), 3);
    person.passportIssuer = "ОВД по г. " + city.n;

    const bik = generateBik();
    const bankRegion = Number(bik.slice(2, 4));
    const bank = {
      name: bankName(),
      bik,
      inn: generateInnUl(bankRegion),
      kpp: generateKpp(bankRegion),
      ks: generateKs(bik),
      rs: generateRs(bik),
    };

    const companyParts = companyNameParts();
    const company = {
      name: companyParts.form + " «" + companyParts.inner + "»",
      website: websiteFromInner(companyParts.inner),
      innUl: generateInnUl(city.c),
      kpp: generateKpp(city.c),
      ogrn: generateOgrn(city.c),
      okpo: generateOkpo(8),
      okpoIp: generateOkpo(10),
      okved: pick(D.OKVED),
    };

    const street = pick(D.STREET_TYPES) + " " + pick(D.STREETS);
    const house = String(randInt(1, 120)) + (Math.random() < 0.15 ? "к" + randInt(1, 4) : "");
    const apartment = String(randInt(1, 299));
    const address = {
      city: city.n,
      region: city.r,
      regionCode: city.c,
      street,
      house,
      apartment,
      zip: city.z + pad(randInt(0, 999), 3),
      oktmo: city.o,
    };
    address.full =
      "г. " + city.n + ", " + street + ", д. " + house + ", кв. " + apartment;

    return { person, company, bank, address };
  }

  function getProfile() {
    if (!profileCache) profileCache = buildProfile();
    return profileCache;
  }

  function regenerateProfile() {
    profileCache = buildProfile();
    return profileCache;
  }

  // Значение по типу поля — то, что вставляет кнопка «Заполнить».
  // opts.maxLen — maxlength поля (если задан и невелик): генератор подбирает
  // формат, который помещается (короткий телефон без +7, СНИЛС без дефисов…).
  function fill(kind, opts) {
    if (!D) return null;
    const p = getProfile();
    const ip = opts && opts.ip;
    const maxLen = opts && opts.maxLen > 0 ? opts.maxLen : 0;
    switch (kind) {
      case "snils": {
        const v = p.person.snils;
        return maxLen && maxLen < v.length ? v.replace(/\D/g, "") : v;
      }
      case "innFl": return p.person.innFl;
      case "innUl": return p.company.innUl;
      case "innKpp": {
        const v = p.company.innUl + "/" + p.company.kpp;
        return maxLen && maxLen < v.length ? p.company.innUl : v;
      }
      case "innBank": return p.bank.inn;
      case "bik": return p.bank.bik;
      case "ks": return p.bank.ks;
      case "rs": return p.bank.rs;
      case "kpp": return (opts && opts.bank) ? p.bank.kpp : p.company.kpp;
      case "ogrn": return p.company.ogrn;
      case "ogrnip": return p.person.ogrnip;
      case "okpo": return ip ? p.company.okpoIp : p.company.okpo;
      case "oktmo": return p.address.oktmo;
      case "okved": return p.company.okved;
      case "bankName": return p.bank.name;
      case "companyName": return p.company.name;
      case "website": return p.company.website;
      case "fio": return p.person.fio;
      case "surname": return p.person.surname;
      case "firstName": return p.person.name;
      case "patronymic": return p.person.patronymic;
      case "city": return p.address.city;
      case "region": return p.address.region;
      case "street": return p.address.street;
      case "house":
        return opts && opts.housePlain
          ? p.address.house.replace(/к\d+$/, "")
          : p.address.house;
      case "apartment": return p.address.apartment;
      case "zip": return p.address.zip;
      case "address": return p.address.full;
      case "email": return p.person.email;
      case "phone": {
        const d = p.person.phoneDigits; // 10 цифр: 9XXXXXXXXX
        if (!maxLen || maxLen >= 16)
          return "+7 " + d.slice(0, 3) + " " + d.slice(3, 6) + "-" + d.slice(6, 8) + "-" + d.slice(8);
        if (maxLen >= 12) return "+7" + d;
        if (maxLen === 11) return "8" + d;
        return d;
      }
      case "passportSeries": return p.person.passportSeries;
      case "passportNumber": return p.person.passportNumber;
      case "passportCode": return p.person.passportCode;
      case "passportIssuer": return p.person.passportIssuer;
      case "passport": {
        const v = p.person.passport;
        return maxLen && maxLen < v.length ? v.replace(" ", "") : v;
      }
      default: return null;
    }
  }

  // --- Форматирование ---
  function formatSnils(digits) {
    const d = digits.replace(/\D/g, "");
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6, 9)} ${d.slice(9, 11)}`;
  }

  // ИНН обычно показываем без группировки (так и копируют), но длина невелика.
  const formatInn = (digits) => digits.replace(/\D/g, "");

  // --- Валидаторы (по контрольным числам) ---
  function validateInn(value) {
    const inn = String(value).replace(/\D/g, "");
    if (!/^\d{10}$|^\d{12}$/.test(inn)) return false;
    const digits = inn.split("").map(Number);

    if (digits.length === 10) {
      const expected = checkDigit(sumProducts(digits.slice(0, 9), COEFF_INN10));
      return expected === digits[9];
    }
    const k11 = checkDigit(sumProducts(digits.slice(0, 10), COEFF_INN12_1));
    if (k11 !== digits[10]) return false;
    const k12 = checkDigit(sumProducts(digits.slice(0, 11), COEFF_INN12_2));
    return k12 === digits[11];
  }

  function validateSnils(value) {
    const digits = String(value).replace(/\D/g, "");
    if (!/^\d{11}$/.test(digits)) return false;
    const seq = digits.slice(0, 9).split("").map(Number);
    const check = Number(digits.slice(9, 11));
    const sum = seq.reduce((acc, d, i) => acc + d * (9 - i), 0);
    let expected;
    if (sum < 100) expected = sum;
    else if (sum === 100) expected = 0;
    else {
      expected = sum % 101;
      if (expected === 100) expected = 0;
    }
    return expected === check;
  }

  function validateOgrn(value) {
    const digits = String(value).replace(/\D/g, "");
    if (!/^\d{13}$/.test(digits)) return false;
    return Number(digits.slice(0, 12)) % 11 % 10 === Number(digits[12]);
  }

  function validateOgrnip(value) {
    const digits = String(value).replace(/\D/g, "");
    if (!/^\d{15}$/.test(digits)) return false;
    return Number(digits.slice(0, 14)) % 13 % 10 === Number(digits[14]);
  }

  function validateOkpo(value) {
    const digits = String(value).replace(/\D/g, "");
    if (!/^\d{8}$|^\d{10}$/.test(digits)) return false;
    const body = digits.slice(0, -1).split("").map(Number);
    return okpoCheckDigit(body) === Number(digits[digits.length - 1]);
  }

  const validateBik = (value) => /^04\d{7}$/.test(String(value).replace(/\D/g, ""));
  const validateAccount = (bik, account) =>
    /^04\d{7}$/.test(bik) && /^\d{20}$/.test(String(account).replace(/\D/g, "")) &&
    accountChecksumOk(bik, account);
  const validateKpp = (value) => /^\d{4}(0[1-9]|[1-4]\d|5\d)\d{3}$/.test(String(value));

  // --- Самопроверка: запускается из popup-консоли или Node ---
  function selfTest(n = 1000) {
    const results = { innUl: 0, innFl: 0, innIp: 0, snils: 0, errors: [] };
    for (let i = 0; i < n; i++) {
      const ul = generateInnUl();
      const fl = generateInnFl();
      const ip = generateInnIp();
      const sn = generateSnils();
      if (validateInn(ul)) results.innUl++;
      else results.errors.push("ИНН ЮЛ: " + ul);
      if (validateInn(fl)) results.innFl++;
      else results.errors.push("ИНН ФЛ: " + fl);
      if (validateInn(ip)) results.innIp++;
      else results.errors.push("ИНН ИП: " + ip);
      if (validateSnils(sn)) results.snils++;
      else results.errors.push("СНИЛС: " + sn);
    }
    results.ok =
      results.innUl === n &&
      results.innFl === n &&
      results.innIp === n &&
      results.snils === n;

    if (D) {
      results.requisites = { pass: 0, errors: [] };
      for (let i = 0; i < n; i++) {
        const p = regenerateProfile();
        const checks = [
          ["БИК", p.bank.bik, validateBik(p.bank.bik)],
          ["ИНН банка", p.bank.inn, validateInn(p.bank.inn)],
          ["КПП банка", p.bank.kpp, validateKpp(p.bank.kpp)],
          ["к/с", p.bank.ks, validateAccount(p.bank.bik, p.bank.ks)],
          ["р/с", p.bank.rs, validateAccount(p.bank.bik, p.bank.rs)],
          ["ОГРН", p.company.ogrn, validateOgrn(p.company.ogrn)],
          ["ОГРНИП", p.person.ogrnip, validateOgrnip(p.person.ogrnip)],
          ["КПП", p.company.kpp, validateKpp(p.company.kpp)],
          ["ИНН ФЛ", p.person.innFl, validateInn(p.person.innFl)],
          ["ИНН ЮЛ", p.company.innUl, validateInn(p.company.innUl)],
          ["ОКПО", p.company.okpo, validateOkpo(p.company.okpo)],
          ["ОКПО ИП", p.company.okpoIp, validateOkpo(p.company.okpoIp)],
          ["индекс", p.address.zip, /^\d{6}$/.test(p.address.zip)],
          ["ОКТМО", p.address.oktmo, /^\d{8}$/.test(p.address.oktmo)],
          ["телефон", p.person.phone, /^\+7 \d{3} \d{3}-\d{2}-\d{2}$/.test(p.person.phone)],
          ["e-mail", p.person.email, /^[a-z0-9.-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(p.person.email)],
          ["ФИО", p.person.fio, /^[А-ЯЁ][а-яё-]+ [А-ЯЁ][а-яё-]+ [А-ЯЁ][а-яё-]+$/.test(p.person.fio)],
          ["адрес", p.address.full, /^г\. .+, .+, д\. \d+(к\d+)?, кв\. \d+$/.test(p.address.full)],
          ["сайт", p.company.website, /^https:\/\/[a-z0-9-]+\.[a-z]{2,}$/.test(p.company.website)],
          ["паспорт: серия+номер", p.person.passport, /^\d{4} \d{6}$/.test(p.person.passport)],
          ["код подразделения", p.person.passportCode, /^\d{3}-\d{3}$/.test(p.person.passportCode)],
          ["согласованность региона", "", String(p.company.innUl).slice(0, 2) === String(p.address.regionCode).padStart(2, "0")],
        ];
        for (const [label, value, ok] of checks) {
          if (ok) results.requisites.pass++;
          else results.requisites.errors.push(label + ": " + value);
        }
      }
      results.requisites.ok = results.requisites.errors.length === 0;
      results.ok = results.ok && results.requisites.ok;
    }
    return results;
  }

  return {
    generateInnUl,
    generateInnFl,
    generateInnIp,
    generateSnils,
    generateBik,
    generateRs,
    generateKs,
    generateKpp,
    generateOgrn,
    generateOgrnip,
    generateOkpo,
    generatePhone,
    bankName,
    companyName,
    getProfile,
    regenerateProfile,
    fill,
    validateInn,
    validateSnils,
    validateBik,
    validateAccount,
    validateKpp,
    validateOgrn,
    validateOgrnip,
    validateOkpo,
    formatInn,
    formatSnils,
    selfTest,
  };
});
