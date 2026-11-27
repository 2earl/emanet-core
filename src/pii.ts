/**
 * Personal data at rest (docs/DESIGN.md §4.4, §8). Values of custom fields marked `pii` are sealed
 * with AES-256-GCM before they reach the database and opened only for an audience allowed to see
 * the field; a copy of the database alone doesn't hold them. The same key, under another label,
 * makes the keyed hash that lets one T.C. kimlik no open one agent account without the number
 * itself ever being stored.
 *
 * The key is the PII_KEY secret: 32 random bytes, base64, made once by the deploy workflow.
 * Sealed values start with "enc:v1:"; a later key or cipher gets a new prefix, and both open.
 */
import { env } from 'cloudflare:workers';

const PREFIX = 'enc:v1:';
const encoder = new TextEncoder();

const bytes = (base64: string) => Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
const base64 = (data: Uint8Array) => {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
};

function rawKey(): Uint8Array {
  const value = (env as unknown as { PII_KEY?: string }).PII_KEY;
  const raw = value ? bytes(value) : new Uint8Array();
  if (raw.length !== 32) throw new Error('PII_KEY must be 32 bytes, base64');
  return raw;
}

let aes: Promise<CryptoKey> | null = null;
let mac: Promise<CryptoKey> | null = null;
const aesKey = () =>
  (aes ??= crypto.subtle.importKey('raw', rawKey(), 'AES-GCM', false, ['encrypt', 'decrypt']));
const macKey = () =>
  (mac ??= crypto.subtle.importKey('raw', rawKey(), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]));

export const isSealed = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREFIX);

/** Seals any JSON value. `context` (the field's key) is bound in: a value can't be moved to another field. */
export async function seal(value: unknown, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
      await aesKey(),
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return `${PREFIX}${base64(iv)}.${base64(sealed)}`;
}

/** Opens a sealed value; anything not sealed (stored before a field was marked `pii`) is returned as it is. */
export async function open(value: unknown, context: string): Promise<unknown> {
  if (!isSealed(value)) return value;
  const [iv = '', sealed = ''] = value.slice(PREFIX.length).split('.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(iv), additionalData: encoder.encode(context) },
    await aesKey(),
    bytes(sealed),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as unknown;
}

/** Seals the values of the fields marked `pii`; everything else is left as it is. */
export async function sealAttributes(
  fields: readonly { key: string; pii: boolean }[],
  attributes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...attributes };
  for (const field of fields) {
    if (field.pii && field.key in out && !isSealed(out[field.key])) {
      out[field.key] = await seal(out[field.key], field.key);
    }
  }
  return out;
}

export async function openAttributes(
  attributes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) out[key] = await open(value, key);
  return out;
}

/** A keyed hash: equal inputs give equal hashes, and without the key neither can be guessed from the other. */
export async function keyedHash(label: string, value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', await macKey(), encoder.encode(`${label}:${value}`)),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
