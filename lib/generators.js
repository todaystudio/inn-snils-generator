/*
 * Генерация корректных ИНН (РФ) и СНИЛС с контрольными числами.
 * Модуль самодостаточный: работает и в popup (через <script>), и в Node для тестов.
 *
 * Методика расчёта контрольных чисел — по приказу ФНС и ПФР:
 *  - ИНН юридического лица — 10 цифр, одна контрольная.
 *  - ИНН физического лица / ИП — 12 цифр, две контрольные.
 *  - СНИЛС — 9 порядковых цифр + 2 контрольные.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.RusID = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // --- Коэффициенты контрольных сумм ---
  const COEFF_INN10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];
  const COEFF_INN12_1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
  const COEFF_INN12_2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];

  // Коды субъектов РФ, используемые как первые две цифры ИНН.
  const REGION_CODES = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
    79, 82, 83, 86, 87, 88, 89, 91, 92, 99,
  ];

  // --- Вспомогательные функции ---
  const randInt = (min, max) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

  const pad = (n, len) => String(n).padStart(len, "0");

  // Возвращает остаток от деления на 11 с приведением 10 -> 0 (правило ФНС).
  const checkDigit = (sum) => {
    const k = sum % 11;
    return k === 10 ? 0 : k;
  };

  const sumProducts = (digits, coeffs) =>
    digits.reduce((acc, d, i) => acc + d * coeffs[i], 0);

  // --- ИНН юридического лица (10 цифр) ---
  // ИП — это физическое лицо, поэтому у ИП 12-значный ИНН (как у ФЛ).
  function generateInnUl() {
    const region = pad(REGION_CODES[randInt(0, REGION_CODES.length - 1)], 2);
    const body = pad(randInt(0, 9999999), 7); // 7 случайных цифр + 2 региона = 9
    const digits = (region + body).split("").map(Number);
    const k10 = checkDigit(sumProducts(digits, COEFF_INN10));
    digits.push(k10);
    return digits.join("");
  }

  // --- ИНН физического лица и ИП (12 цифр) ---
  function generateInnFl() {
    const region = pad(REGION_CODES[randInt(0, REGION_CODES.length - 1)], 2);
    const body = pad(randInt(0, 99999999), 8); // 8 случайных + 2 региона = 10
    const digits = (region + body).split("").map(Number);
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
    return results;
  }

  return {
    generateInnUl,
    generateInnFl,
    generateInnIp,
    generateSnils,
    validateInn,
    validateSnils,
    formatInn,
    formatSnils,
    selfTest,
  };
});
