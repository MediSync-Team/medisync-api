export const CLINIC_TIME_ZONE = 'America/Argentina/Buenos_Aires';
export const CLINIC_UTC_OFFSET_MINUTES = -180;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

const clinicDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CLINIC_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export type ClinicDateParts = {
  year: number;
  month: number;
  day: number;
};

export type ClinicDateTimeParts = ClinicDateParts & {
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  dateKey: string;
  timeKey: string;
};

export function parseClinicDateString(date: string): ClinicDateParts {
  const match = DATE_RE.exec(date);
  if (!match) {
    throw new Error('Invalid clinic date. Expected YYYY-MM-DD.');
  }

  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));

  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new Error('Invalid clinic date.');
  }

  return { year, month, day };
}

export function parseClinicTimeString(time: string): { hour: number; minute: number } {
  const match = TIME_RE.exec(time);
  if (!match) {
    throw new Error('Invalid clinic time. Expected HH:mm.');
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error('Invalid clinic time.');
  }

  return { hour, minute };
}

export function formatClinicDateKey(date: Date): string {
  const parts = getClinicDateTimeParts(date);
  return parts.dateKey;
}

export function getClinicDateTimeParts(date: Date): ClinicDateTimeParts {
  const rawParts = clinicDateTimeFormatter.formatToParts(date);
  const values = Object.fromEntries(rawParts.map((part) => [part.type, part.value]));

  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  const second = Number(values.second);
  const dateKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: getClinicWeekdayFromDateString(dateKey),
    dateKey,
    timeKey: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

export function getClinicWeekdayFromDateString(date: string): number {
  const { year, month, day } = parseClinicDateString(date);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0)).getUTCDay();
}

export function clinicDateTimeToUtcDate(date: string, time: string): Date {
  const { year, month, day } = parseClinicDateString(date);
  const { hour, minute } = parseClinicTimeString(time);
  return new Date(Date.UTC(year, month - 1, day, hour - CLINIC_UTC_OFFSET_MINUTES / 60, minute, 0, 0));
}

export function clinicDatePartsToUtcDate(parts: ClinicDateParts, time: string): Date {
  const date = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  return clinicDateTimeToUtcDate(date, time);
}

export function getClinicDayBoundsFromDateString(date: string): { start: Date; end: Date } {
  const { year, month, day } = parseClinicDateString(date);
  const start = new Date(Date.UTC(year, month - 1, day, -CLINIC_UTC_OFFSET_MINUTES / 60, 0, 0, 0));
  const end = new Date(Date.UTC(year, month - 1, day + 1, -CLINIC_UTC_OFFSET_MINUTES / 60, 0, 0, 0));
  return { start, end };
}

export function getClinicDayBoundsForInstant(date: Date): { start: Date; end: Date } {
  return getClinicDayBoundsFromDateString(formatClinicDateKey(date));
}

export function getClinicDateOnlyUtc(date: string): Date {
  return getClinicDayBoundsFromDateString(date).start;
}

export function addDaysToClinicDate(date: string, days: number): string {
  const { year, month, day } = parseClinicDateString(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function formatClinicDateTimeEs(date: Date): string {
  return date.toLocaleString('es-AR', { timeZone: CLINIC_TIME_ZONE });
}
