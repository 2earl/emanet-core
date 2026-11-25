/**
 * What every core operation returns. Errors are values, not exceptions, so they cross the Service
 * Binding intact and each app can word them for its own users.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; detail?: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T = never>(error: string, detail?: string): Result<T> =>
  detail === undefined ? { ok: false, error } : { ok: false, error, detail };

export const now = (): number => Math.floor(Date.now() / 1000);

export const newId = (): string => crypto.randomUUID();
