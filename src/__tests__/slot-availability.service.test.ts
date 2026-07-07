import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPrisma = {
  disponibilidad: { findMany: jest.fn() as any },
  turno: { findMany: jest.fn() as any },
  bloqueoDisponibilidad: { findMany: jest.fn() as any },
};

jest.mock('../lib/prisma', () => ({
  __esModule: true,
  default: mockPrisma,
}));

import { getAvailableSlotsForProfessional } from '../services/slot-availability.service';

describe('getAvailableSlotsForProfessional past-time filtering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.turno.findMany.mockResolvedValue([]);
    mockPrisma.bloqueoDisponibilidad.findMany.mockResolvedValue([]);
    // 2026-07-07 and 2026-07-14 are Tuesdays (diaSemana 2).
    mockPrisma.disponibilidad.findMany.mockResolvedValue([
      { diaSemana: 2, horaInicio: '09:00', horaFin: '17:00', modalidad: 'PRESENCIAL', lugarAtencion: null, activo: true },
    ]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('hides start times that already passed on the queried day', async () => {
    // 17:00Z = 14:00 clinic time (UTC-3), so the morning grid is already gone.
    jest.useFakeTimers().setSystemTime(new Date('2026-07-07T17:00:00.000Z'));

    const slots = await getAvailableSlotsForProfessional({
      profesionalId: 'prof-1',
      fecha: '2026-07-07',
      duracionMin: 30,
    });

    // 14:00 itself is excluded too: booking.service rejects fechaHora <= now.
    expect(slots.map((s) => s.hora)).toEqual(['14:30', '15:00', '15:30', '16:00', '16:30']);
  });

  it('keeps the full grid for future days', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-07T17:00:00.000Z'));

    const slots = await getAvailableSlotsForProfessional({
      profesionalId: 'prof-1',
      fecha: '2026-07-14',
      duracionMin: 30,
    });

    expect(slots[0]?.hora).toBe('09:00');
    expect(slots).toHaveLength(16);
  });
});
