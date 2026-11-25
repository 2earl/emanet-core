/**
 * Custom fields (docs/DESIGN.md §4.4): the columns each partner needs beyond the core ones, as
 * data. A new partner's fields are rows in `field_definitions`, not a migration. Values live in
 * the entity's `attributes` JSON and are checked here on every write.
 */
import { fail, newId, ok, type Result } from './result';

export type FieldEntity = 'vehicle' | 'case' | 'place';
export type FieldType = 'text' | 'number' | 'date' | 'enum' | 'bool' | 'phone' | 'money';
export type FieldVisibility = 'partner' | 'admin' | 'agent_after_claim';

export interface FieldDefinition {
  id: string;
  partnerId: string | null;
  entity: FieldEntity;
  key: string;
  labelTr: string;
  labelEn: string;
  type: FieldType;
  enumValues: string[] | null;
  required: boolean;
  maxLength: number | null;
  visibility: FieldVisibility;
  pii: boolean;
  position: number;
  deprecated: boolean;
}

interface FieldRow {
  id: string;
  partner_id: string | null;
  entity: FieldEntity;
  key: string;
  label_tr: string;
  label_en: string;
  type: FieldType;
  enum_values: string | null;
  required: number;
  max_length: number | null;
  visibility: FieldVisibility;
  pii: number;
  position: number;
  deprecated_at: number | null;
}

const toDefinition = (row: FieldRow): FieldDefinition => ({
  id: row.id,
  partnerId: row.partner_id,
  entity: row.entity,
  key: row.key,
  labelTr: row.label_tr,
  labelEn: row.label_en,
  type: row.type,
  enumValues: row.enum_values === null ? null : (JSON.parse(row.enum_values) as string[]),
  required: row.required === 1,
  maxLength: row.max_length,
  visibility: row.visibility,
  pii: row.pii === 1,
  position: row.position,
  deprecated: row.deprecated_at !== null,
});

/** The fields in force for one partner and entity: the global ones and the partner's own. */
export async function fieldsFor(
  db: D1Database,
  partnerId: string,
  entity: FieldEntity,
): Promise<FieldDefinition[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM field_definitions
       WHERE entity = ? AND (partner_id IS NULL OR partner_id = ?)
       ORDER BY position, key`,
    )
    .bind(entity, partnerId)
    .all<FieldRow>();
  return results.map(toDefinition);
}

export interface NewField {
  partnerId: string | null;
  entity: FieldEntity;
  key: string;
  labelTr: string;
  labelEn: string;
  type: FieldType;
  enumValues?: string[];
  required?: boolean;
  maxLength?: number;
  visibility?: FieldVisibility;
  pii?: boolean;
  position?: number;
}

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
// The core columns: a custom field can't shadow them.
const RESERVED = new Set([
  'id',
  'vin',
  'plate',
  'make',
  'model',
  'year',
  'colour',
  'external_ref',
  'icra_office',
  'icra_file_no',
  'serh_date',
  'legal_basis',
  'status',
  'places',
  'address',
  'district',
  'city',
  'lat',
  'lng',
  'kind',
  'note',
  'fee',
  'fee_kurus',
]);

/** Checks a definition before staff save it. */
export function checkDefinition(field: NewField): Result<NewField> {
  if (!KEY.test(field.key))
    return fail('invalid_key', 'Use a-z, 0-9 and _, starting with a letter.');
  if (RESERVED.has(field.key)) return fail('reserved_key', field.key);
  if (!field.labelTr.trim() || !field.labelEn.trim()) return fail('missing_label');
  if (field.type === 'enum') {
    const values = field.enumValues ?? [];
    if (values.length === 0 || new Set(values).size !== values.length) {
      return fail('invalid_enum_values');
    }
  } else if (field.enumValues !== undefined) {
    return fail('enum_values_without_enum');
  }
  if (field.maxLength !== undefined && (field.maxLength < 1 || field.maxLength > 10_000)) {
    return fail('invalid_max_length');
  }
  return ok(field);
}

export function insertDefinition(db: D1Database, field: NewField, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO field_definitions (id, partner_id, entity, key, label_tr, label_en, type,
         enum_values, required, max_length, visibility, pii, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      field.partnerId,
      field.entity,
      field.key,
      field.labelTr.trim(),
      field.labelEn.trim(),
      field.type,
      field.enumValues === undefined ? null : JSON.stringify(field.enumValues),
      field.required === true ? 1 : 0,
      field.maxLength ?? null,
      field.visibility ?? 'partner',
      field.pii === true ? 1 : 0,
      field.position ?? 0,
      at,
    );
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE = /^\+?[0-9 ()-]{7,20}$/;

function checkValue(field: FieldDefinition, value: unknown): string | null {
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return 'must be text';
      if (value.length > (field.maxLength ?? 1000)) return 'is too long';
      return null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'money':
      // Integer kuruş, like every amount in Emanet.
      return Number.isSafeInteger(value) && (value as number) >= 0 ? null : 'must be whole kuruş';
    case 'date':
      return typeof value === 'string' &&
        DATE.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
        ? null
        : 'must be a date (YYYY-MM-DD)';
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'phone':
      return typeof value === 'string' && PHONE.test(value) ? null : 'must be a phone number';
    case 'enum':
      return typeof value === 'string' && (field.enumValues ?? []).includes(value)
        ? null
        : `must be one of: ${(field.enumValues ?? []).join(', ')}`;
  }
}

/**
 * Validates a write of `attributes` against the definitions in force and merges it into what is
 * stored. Unknown keys are refused, so a typo can't store data nobody sees. A deprecated field
 * keeps its stored value but accepts no new one. `null` clears an optional field. A partner can't
 * see or touch staff-only fields; their stored values are kept as they are.
 */
export function validateAttributes(
  all: readonly FieldDefinition[],
  input: unknown,
  writer: 'partner' | 'admin',
  stored: Record<string, unknown> = {},
): Result<Record<string, unknown>> {
  const changes = input ?? {};
  if (typeof changes !== 'object' || Array.isArray(changes)) return fail('invalid_attributes');
  const writable = writer === 'admin' ? all : all.filter((f) => f.visibility !== 'admin');
  const byKey = new Map(writable.map((field) => [field.key, field]));
  const merged = new Map(Object.entries(stored));
  for (const [key, value] of Object.entries(changes)) {
    const field = byKey.get(key);
    if (!field) return fail('unknown_field', key);
    if (value === null) {
      if (field.required && !field.deprecated) return fail('invalid_field', `${key} is required`);
      merged.delete(key);
      continue;
    }
    if (field.deprecated) {
      if (JSON.stringify(stored[key]) === JSON.stringify(value)) continue;
      return fail('deprecated_field', key);
    }
    const problem = checkValue(field, value);
    if (problem) return fail('invalid_field', `${key} ${problem}`);
    merged.set(key, value);
  }
  for (const field of writable) {
    if (field.required && !field.deprecated && !merged.has(field.key)) {
      return fail('invalid_field', `${field.key} is required`);
    }
  }
  return ok(Object.fromEntries(merged));
}

/** Only the attributes a given audience may see. */
export function visibleAttributes(
  definitions: readonly FieldDefinition[],
  attributes: Record<string, unknown>,
  audience: 'partner' | 'admin' | 'agent',
): Record<string, unknown> {
  const allowed = new Set(
    definitions
      .filter((field) =>
        audience === 'admin'
          ? true
          : audience === 'partner'
            ? field.visibility !== 'admin'
            : field.visibility === 'agent_after_claim',
      )
      .map((field) => field.key),
  );
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => allowed.has(key)));
}
