import {
  clinicDateTimeToUtcDate,
  getClinicDateTimeParts,
  getClinicDayBoundsFromDateString,
} from '../utils/clinic-time';

describe('clinic-time utilities', () => {
  it('converts Argentina local appointment time to a UTC instant', () => {
    expect(clinicDateTimeToUtcDate('2026-05-18', '10:00').toISOString()).toBe('2026-05-18T13:00:00.000Z');
  });

  it('reads a UTC instant back as Argentina local appointment parts', () => {
    const parts = getClinicDateTimeParts(new Date('2026-05-18T13:00:00.000Z'));

    expect(parts).toMatchObject({
      dateKey: '2026-05-18',
      timeKey: '10:00',
      weekday: 1,
      hour: 10,
      minute: 0,
    });
  });

  it('uses Argentina calendar-day bounds for date-only queries', () => {
    const bounds = getClinicDayBoundsFromDateString('2026-05-18');

    expect(bounds.start.toISOString()).toBe('2026-05-18T03:00:00.000Z');
    expect(bounds.end.toISOString()).toBe('2026-05-19T03:00:00.000Z');
  });

  it('keeps late-night Argentina slots on the Argentina weekday', () => {
    const parts = getClinicDateTimeParts(new Date('2026-05-19T02:30:00.000Z'));

    expect(parts.dateKey).toBe('2026-05-18');
    expect(parts.timeKey).toBe('23:30');
    expect(parts.weekday).toBe(1);
  });
});
