import { describe, expect, it, beforeEach, jest } from '@jest/globals';

const mockPrisma = {
  turno: { updateMany: jest.fn() as any, update: jest.fn() as any },
  usuario: { findUnique: jest.fn() as any },
  auditoriaDisponibilidad: { create: jest.fn() as any },
};
jest.mock('../lib/prisma', () => ({ __esModule: true, default: mockPrisma }));

const mockRefundPagoForTurno = jest.fn() as any;
jest.mock('../services/pagos/refund.service', () => ({
  refundPagoForTurno: (...args: any[]) => mockRefundPagoForTurno(...args),
}));

const mockNotifyWaitlist = jest.fn() as any;
jest.mock('../services/waitlist.service', () => ({
  notifyWaitlistForReleasedSlot: (...args: any[]) => mockNotifyWaitlist(...args),
}));

const mockAssertTurnoAccess = jest.fn() as any;
const mockCanCancelTurno = jest.fn() as any;
const mockGetTurnoStatusResponse = jest.fn() as any;
const mockNotifyTurnoUser = jest.fn() as any;
jest.mock('../services/turnos/turno-helpers', () => ({
  assertTurnoAccess: (...args: any[]) => mockAssertTurnoAccess(...args),
  canCancelTurno: (...args: any[]) => mockCanCancelTurno(...args),
  getTurnoStatusResponse: (...args: any[]) => mockGetTurnoStatusResponse(...args),
  notifyTurnoUser: (...args: any[]) => mockNotifyTurnoUser(...args),
}));

import { cambiarEstadoTurno } from '../services/turnos/estado.service';

const turnoId = 'turno-1';

function buildTurnoStatus(estado = 'CANCELADO') {
  return {
    id: turnoId,
    estado,
    fechaHora: new Date('2026-07-10T14:00:00Z'),
    modalidad: 'PRESENCIAL',
    profesionalId: 'prof-1',
    pacienteId: 'pac-1',
    lugarAtencion: null,
    linkVideollamada: null,
    paciente: {
      usuarioId: 'user-pac',
      nombre: 'Juan',
      apellido: 'Pérez',
      email: 'juan@test.com',
      telefono: null,
      notifEmail: true,
      notifWhatsapp: false,
    },
    profesional: {
      usuarioId: 'user-prof',
      nombre: 'Ana',
      apellido: 'García',
      telefono: null,
      lugarAtencion: 'Consultorio',
      notifEmail: true,
      notifWhatsapp: false,
      especialidad: { nombre: 'Clínica' },
    },
  };
}

describe('cambiarEstadoTurno — reembolso automático al cancelar', () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCanCancelTurno.mockReturnValue(true);
    mockPrisma.turno.updateMany.mockResolvedValue({ count: 1 });
    mockGetTurnoStatusResponse.mockResolvedValue(buildTurnoStatus());
    mockRefundPagoForTurno.mockResolvedValue('refunded');
    mockNotifyTurnoUser.mockResolvedValue(undefined);
    mockNotifyWaitlist.mockResolvedValue(undefined);
    mockPrisma.usuario.findUnique.mockResolvedValue({ email: 'prof@test.com' });
    mockPrisma.auditoriaDisponibilidad.create.mockResolvedValue({});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('dispara el reembolso cuando el paciente cancela', async () => {
    mockAssertTurnoAccess.mockResolvedValue({
      turno: { estado: 'CONFIRMADO', fechaHora: new Date('2026-07-10T14:00:00Z') },
      isPacienteOwner: true,
      isProfesionalOwner: false,
    });

    const result = await cambiarEstadoTurno({
      turnoId,
      userId: 'user-pac',
      estado: 'CANCELADO',
      notasCancelacion: 'No puedo asistir',
    });

    expect(mockRefundPagoForTurno).toHaveBeenCalledWith(turnoId, { motivo: 'No puedo asistir' });
    expect(result.fireCancelSync).toBe(true);
  });

  it('dispara el reembolso cuando el profesional cancela', async () => {
    mockAssertTurnoAccess.mockResolvedValue({
      turno: { estado: 'RESERVADO', fechaHora: new Date('2026-07-10T14:00:00Z') },
      isPacienteOwner: false,
      isProfesionalOwner: true,
    });

    await cambiarEstadoTurno({ turnoId, userId: 'user-prof', estado: 'CANCELADO' });

    expect(mockRefundPagoForTurno).toHaveBeenCalledWith(turnoId, { motivo: undefined });
  });

  it('la cancelación sale igual cuando el reembolso falla', async () => {
    mockAssertTurnoAccess.mockResolvedValue({
      turno: { estado: 'CONFIRMADO', fechaHora: new Date('2026-07-10T14:00:00Z') },
      isPacienteOwner: false,
      isProfesionalOwner: true,
    });
    mockRefundPagoForTurno.mockResolvedValue('failed');

    const result = await cambiarEstadoTurno({ turnoId, userId: 'user-prof', estado: 'CANCELADO' });

    expect(result.turno.estado).toBe('CANCELADO');
    expect(result.fireCancelSync).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      '[turnos] Cancelación sin reembolso: reintentar manualmente',
      { turnoId },
    );
    expect(mockNotifyTurnoUser).toHaveBeenCalled();
  });

  it('la cancelación sale igual cuando el servicio de reembolso tira una excepción inesperada', async () => {
    mockAssertTurnoAccess.mockResolvedValue({
      turno: { estado: 'CONFIRMADO', fechaHora: new Date('2026-07-10T14:00:00Z') },
      isPacienteOwner: false,
      isProfesionalOwner: true,
    });
    mockRefundPagoForTurno.mockRejectedValue(new Error('boom'));

    const result = await cambiarEstadoTurno({ turnoId, userId: 'user-prof', estado: 'CANCELADO' });

    expect(result.turno.estado).toBe('CANCELADO');
  });

  it('no reembolsa en transiciones que no son cancelación', async () => {
    mockAssertTurnoAccess.mockResolvedValue({
      turno: { estado: 'RESERVADO', fechaHora: new Date('2026-07-10T14:00:00Z') },
      isPacienteOwner: false,
      isProfesionalOwner: true,
    });
    mockPrisma.turno.update.mockResolvedValue(buildTurnoStatus('CONFIRMADO'));

    await cambiarEstadoTurno({ turnoId, userId: 'user-prof', estado: 'CONFIRMADO' });

    expect(mockRefundPagoForTurno).not.toHaveBeenCalled();
  });

  it('no reembolsa dos veces un turno ya cancelado (short-circuit)', async () => {
    mockAssertTurnoAccess.mockResolvedValue({
      turno: { estado: 'CANCELADO', fechaHora: new Date('2026-07-10T14:00:00Z') },
      isPacienteOwner: false,
      isProfesionalOwner: true,
    });

    await cambiarEstadoTurno({ turnoId, userId: 'user-prof', estado: 'CANCELADO' });

    expect(mockRefundPagoForTurno).not.toHaveBeenCalled();
  });
});
