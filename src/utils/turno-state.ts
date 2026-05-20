export const PAYABLE_TURNO_STATES = ['RESERVADO', 'CONFIRMADO'] as const;

export const TURNO_STATE_TRANSITIONS: Record<string, string[]> = {
  RESERVADO: ['CONFIRMADO', 'CANCELADO', 'AUSENTE'],
  CONFIRMADO: ['COMPLETADO', 'CANCELADO', 'AUSENTE'],
  COMPLETADO: [],
  CANCELADO: [],
  AUSENTE: [],
};

export function isPayableTurnoState(estado?: string | null): boolean {
  return !!estado && PAYABLE_TURNO_STATES.includes(estado as any);
}

export function canTransitionTurnoState(from?: string | null, to?: string | null): boolean {
  if (!from || !to) return false;
  return TURNO_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}
