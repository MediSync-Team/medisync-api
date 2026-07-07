const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGIN_ATTEMPTS = 10;

type LoginLockoutUser = {
  failedLoginAttempts: number | null;
  lastFailedLoginAt: Date | null;
  lockedUntil: Date | null;
};

export function isAccountLocked(user: LoginLockoutUser, now = new Date()) {
  return Boolean(user.lockedUntil && user.lockedUntil > now);
}

export function getRemainingLockMinutes(user: LoginLockoutUser, now = new Date()) {
  if (!user.lockedUntil || user.lockedUntil <= now) return 0;
  return Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60000);
}

export function getFailedLoginUpdate(user: LoginLockoutUser, now = new Date()) {
  const lastFailedAt = user.lastFailedLoginAt?.getTime() ?? 0;
  const lockedUntil = user.lockedUntil && user.lockedUntil > now ? user.lockedUntil : null;
  const hasRecentFailure = lastFailedAt > 0 && now.getTime() - lastFailedAt < FAILED_LOGIN_WINDOW_MS;
  const currentFailedAttempts = lockedUntil || hasRecentFailure ? (user.failedLoginAttempts ?? 0) : 0;
  const failedLoginAttempts = currentFailedAttempts + 1;
  const nextLockedUntil = failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS
    ? new Date(now.getTime() + LOCK_DURATION_MS)
    : null;

  return {
    failedLoginAttempts,
    lockedUntil: nextLockedUntil,
    lastFailedLoginAt: now,
  };
}
