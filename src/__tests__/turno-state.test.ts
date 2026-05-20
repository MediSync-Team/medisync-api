import { canTransitionTurnoState, isPayableTurnoState } from '../utils/turno-state';

describe('turno state helpers', () => {
  it('allows only the supported appointment state transitions', () => {
    expect(canTransitionTurnoState('RESERVADO', 'CONFIRMADO')).toBe(true);
    expect(canTransitionTurnoState('RESERVADO', 'CANCELADO')).toBe(true);
    expect(canTransitionTurnoState('RESERVADO', 'AUSENTE')).toBe(true);
    expect(canTransitionTurnoState('RESERVADO', 'COMPLETADO')).toBe(false);

    expect(canTransitionTurnoState('CONFIRMADO', 'COMPLETADO')).toBe(true);
    expect(canTransitionTurnoState('CONFIRMADO', 'CANCELADO')).toBe(true);
    expect(canTransitionTurnoState('CONFIRMADO', 'AUSENTE')).toBe(true);
    expect(canTransitionTurnoState('CONFIRMADO', 'RESERVADO')).toBe(false);
  });

  it('treats completed, cancelled, and absent appointments as terminal states', () => {
    for (const state of ['COMPLETADO', 'CANCELADO', 'AUSENTE']) {
      expect(canTransitionTurnoState(state, 'RESERVADO')).toBe(false);
      expect(canTransitionTurnoState(state, 'CONFIRMADO')).toBe(false);
      expect(canTransitionTurnoState(state, 'CANCELADO')).toBe(false);
    }
  });

  it('identifies payable appointment states', () => {
    expect(isPayableTurnoState('RESERVADO')).toBe(true);
    expect(isPayableTurnoState('CONFIRMADO')).toBe(true);
    expect(isPayableTurnoState('CANCELADO')).toBe(false);
    expect(isPayableTurnoState('COMPLETADO')).toBe(false);
    expect(isPayableTurnoState('AUSENTE')).toBe(false);
  });
});
