export type AdvisoryLockTransaction = {
  $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
};

export function buildAppointmentDayLockKey(profesionalId: string, clinicDateKey: string): string {
  return `turno:${profesionalId}:${clinicDateKey}`;
}

export async function acquireAppointmentDayLock(
  tx: AdvisoryLockTransaction,
  profesionalId: string,
  clinicDateKey: string
): Promise<void> {
  const lockKey = buildAppointmentDayLockKey(profesionalId, clinicDateKey);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;
}
