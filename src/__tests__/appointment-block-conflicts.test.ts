import {
  appointmentFitsAvailability,
  appointmentOverlapsBlock,
  findMatchingAvailability,
  hasBlockConflict,
} from '../utils/appointment-conflicts';
import { buildAppointmentDayLockKey } from '../utils/appointment-locks';

describe('availability block interval overlap', () => {
  it('detects partial overlap when the appointment starts before the block', () => {
    expect(appointmentOverlapsBlock({ horaInicio: '10:15', horaFin: '10:45' }, 10 * 60, 30)).toBe(true);
  });

  it('does not block an appointment that ends exactly when the block starts', () => {
    expect(appointmentOverlapsBlock({ horaInicio: '10:30', horaFin: '11:00' }, 10 * 60, 30)).toBe(false);
  });

  it('does not block an appointment that starts exactly when the block ends', () => {
    expect(appointmentOverlapsBlock({ horaInicio: '10:00', horaFin: '10:30' }, 10 * 60 + 30, 30)).toBe(false);
  });

  it('treats full-day blocks as conflicts', () => {
    expect(hasBlockConflict([{ horaInicio: null, horaFin: null }], 10 * 60, 30)).toBe(true);
  });
});

describe('appointment advisory lock keys', () => {
  it('uses the same key for the same professional and clinic date', () => {
    expect(buildAppointmentDayLockKey('prof-1', '2026-05-18')).toBe(
      buildAppointmentDayLockKey('prof-1', '2026-05-18')
    );
  });

  it('uses a different key for a different clinic date', () => {
    expect(buildAppointmentDayLockKey('prof-1', '2026-05-18')).not.toBe(
      buildAppointmentDayLockKey('prof-1', '2026-05-19')
    );
  });

  it('uses a different key for a different professional', () => {
    expect(buildAppointmentDayLockKey('prof-1', '2026-05-18')).not.toBe(
      buildAppointmentDayLockKey('prof-2', '2026-05-18')
    );
  });
});

describe('availability interval containment', () => {
  it('allows an appointment fully contained by availability', () => {
    expect(appointmentFitsAvailability({ horaInicio: '09:00', horaFin: '10:30' }, 10 * 60, 30)).toBe(true);
  });

  it('rejects an appointment that extends past availability end', () => {
    expect(appointmentFitsAvailability({ horaInicio: '09:00', horaFin: '10:15' }, 10 * 60, 30)).toBe(false);
  });

  it('allows an appointment ending exactly at availability end', () => {
    expect(appointmentFitsAvailability({ horaInicio: '09:00', horaFin: '10:30' }, 10 * 60, 30)).toBe(true);
  });

  it('rejects an appointment starting exactly at availability end', () => {
    expect(appointmentFitsAvailability({ horaInicio: '09:00', horaFin: '10:30' }, 10 * 60 + 30, 30)).toBe(false);
  });

  it('keeps modality matching unchanged', () => {
    const availabilities = [
      { horaInicio: '09:00', horaFin: '12:00', modalidad: 'VIRTUAL' },
      { horaInicio: '09:00', horaFin: '12:00', modalidad: 'AMBOS' },
    ];

    expect(findMatchingAvailability(availabilities, 'PRESENCIAL', 10 * 60, 30)).toBe(availabilities[1]);
    expect(findMatchingAvailability([availabilities[0]], 'PRESENCIAL', 10 * 60, 30)).toBeUndefined();
  });
});
