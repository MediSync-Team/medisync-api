import {
  appointmentFitsAvailability,
  appointmentOverlapsBlock,
  findMatchingAvailability,
  hasBlockConflict,
} from '../utils/appointment-conflicts';

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
