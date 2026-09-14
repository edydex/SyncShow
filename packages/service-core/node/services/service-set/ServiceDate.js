'use strict';

const MONTHS = Object.freeze({
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
});

function isValidDateParts({ year, month, day } = {}) {
  if (!Number.isInteger(year) || year < 2000 || year > 2099) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year
    && value.getUTCMonth() === month - 1
    && value.getUTCDate() === day;
}

function toIsoDate(parts) {
  if (!isValidDateParts(parts)) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  return Boolean(match) && isValidDateParts({
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  });
}

function resolveNumericDate(first, second, year, dateOrder) {
  if (first > 12) return { year, month: second, day: first };
  if (second > 12) return { year, month: first, day: second };
  return dateOrder === 'dmy'
    ? { year, month: second, day: first }
    : { year, month: first, day: second };
}

/**
 * Extract one semantic service date from a title or filename. Modified time is
 * deliberately not considered: copying an old deck today must not make it a
 * current service file.
 */
function parseServiceDate(value, { dateOrder = 'mdy' } = {}) {
  if (typeof value !== 'string' || !['mdy', 'dmy'].includes(dateOrder)) return null;
  const basename = value.replace(/\\/g, '/').split('/').pop() || '';
  const patterns = [
    [/(?<![\p{L}\p{N}])(20\d{2})[-._]?(\d{2})[-._]?(\d{2})(?![\p{L}\p{N}])/u, match => ({
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3])
    })],
    [/(?<![\p{L}\p{N}])(\d{1,2})[-.\s_]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-.\s_]*(20\d{2})(?![\p{L}\p{N}])/iu, match => ({
      year: Number(match[3]), month: MONTHS[match[2].toLowerCase().slice(0, 3)], day: Number(match[1])
    })],
    [/(?<![\p{L}\p{N}])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-.\s_]*(\d{1,2})[-.\s_]*(20\d{2})(?![\p{L}\p{N}])/iu, match => ({
      year: Number(match[3]), month: MONTHS[match[1].toLowerCase().slice(0, 3)], day: Number(match[2])
    })],
    [/(?<![\p{L}\p{N}])(\d{1,2})[\/\-._](\d{1,2})[\/\-._](20\d{2})(?![\p{L}\p{N}])/u, match =>
      resolveNumericDate(Number(match[1]), Number(match[2]), Number(match[3]), dateOrder)],
    [/(?<![\p{L}\p{N}])(20\d{2})[\/\-._](\d{1,2})[\/\-._](\d{1,2})(?![\p{L}\p{N}])/u, match => ({
      year: Number(match[1]), month: Number(match[2]), day: Number(match[3])
    })],
    [/(?<![\p{L}\p{N}])(\d{1,2})[\/\-._](\d{1,2})[\/\-._](\d{2})(?![\p{L}\p{N}])/u, match =>
      resolveNumericDate(Number(match[1]), Number(match[2]), 2000 + Number(match[3]), dateOrder)]
  ];

  const candidates = [];
  for (const [priority, [pattern, parse]] of patterns.entries()) {
    const match = basename.match(pattern);
    if (!match) continue;
    const isoDate = toIsoDate(parse(match));
    if (isoDate) candidates.push({ isoDate, index: match.index, priority });
  }
  candidates.sort((first, second) => first.index - second.index || first.priority - second.priority);
  return candidates[0]?.isoDate || null;
}

function serviceDateForTimeZone(date = new Date(), timeZone = null) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('A valid date is required');
  }
  const options = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(timeZone ? { timeZone } : {})
  };
  const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

module.exports = {
  isValidDateParts,
  isValidIsoDate,
  parseServiceDate,
  serviceDateForTimeZone,
  toIsoDate
};
