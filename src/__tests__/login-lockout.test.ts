import { describe, expect, it } from '@jest/globals';
import { getFailedLoginUpdate, getRemainingLockMinutes, isAccountLocked } from '../utils/login-lockout';

describe('login lockout policy', () => {
  it('does not keep stale failed attempts sticky forever', () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    const staleUser = {
      failedLoginAttempts: 9,
      lastFailedLoginAt: new Date('2026-07-07T11:00:00.000Z'),
      lockedUntil: null,
    };

    const firstNewFailure = getFailedLoginUpdate(staleUser, now);

    expect(firstNewFailure.failedLoginAttempts).toBe(1);
    expect(firstNewFailure.lockedUntil).toBeNull();
  });

  it('locks after 10 recent failed attempts', () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    const recentUser = {
      failedLoginAttempts: 9,
      lastFailedLoginAt: new Date('2026-07-07T11:55:00.000Z'),
      lockedUntil: null,
    };

    const update = getFailedLoginUpdate(recentUser, now);

    expect(update.failedLoginAttempts).toBe(10);
    expect(update.lockedUntil?.toISOString()).toBe('2026-07-07T12:15:00.000Z');
  });

  it('treats expired locks as expired failure windows', () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    const expiredLockUser = {
      failedLoginAttempts: 10,
      lastFailedLoginAt: new Date('2026-07-07T11:30:00.000Z'),
      lockedUntil: new Date('2026-07-07T11:45:00.000Z'),
    };

    expect(isAccountLocked(expiredLockUser, now)).toBe(false);

    const update = getFailedLoginUpdate(expiredLockUser, now);

    expect(update.failedLoginAttempts).toBe(1);
    expect(update.lockedUntil).toBeNull();
  });

  it('reports remaining lock minutes for active locks', () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    const lockedUser = {
      failedLoginAttempts: 10,
      lastFailedLoginAt: now,
      lockedUntil: new Date('2026-07-07T12:10:01.000Z'),
    };

    expect(isAccountLocked(lockedUser, now)).toBe(true);
    expect(getRemainingLockMinutes(lockedUser, now)).toBe(11);
  });
});
