/**
 * One list of places for everything: a case's places, an agent's city, the vehicle list's
 * filter. Names arrive as people type them ("ISTANBUL", "Kadikoy", "kahramanmaraş"); each is
 * matched to the official province and district so the same place is always written the same
 * way (docs/DESIGN.md §4).
 */
import { PROVINCES } from './places-data';
import { fail, ok, type Result } from './result';

export { PROVINCES };

const FOLD: Record<string, string> = {
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u',
  â: 'a',
  î: 'i',
  û: 'u',
};

/** A name reduced to what people agree on: Turkish lower case, no accents, letters and digits only. */
export function placeKey(value: string): string {
  return value
    .normalize('NFC')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (ch) => FOLD[ch] ?? ch)
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '');
}

/** Old and short names still in use for a province. */
const PROVINCE_ALIASES: Record<string, string> = {
  afyon: 'Afyonkarahisar',
  maras: 'Kahramanmaraş',
  kmaras: 'Kahramanmaraş',
  urfa: 'Şanlıurfa',
  antep: 'Gaziantep',
  icel: 'Mersin',
};

type Province = (typeof PROVINCES)[number];

let byKey: Map<string, Province> | null = null;
let districtKeys: Map<string, Map<string, string>> | null = null;

function index(): {
  provinces: Map<string, Province>;
  districts: Map<string, Map<string, string>>;
} {
  if (!byKey || !districtKeys) {
    byKey = new Map();
    districtKeys = new Map();
    for (const p of PROVINCES) {
      byKey.set(placeKey(p.name), p);
      byKey.set(p.code, p);
      byKey.set(String(Number(p.code)), p);
      districtKeys.set(p.name, new Map(p.districts.map((d) => [placeKey(d), d])));
    }
    for (const [alias, name] of Object.entries(PROVINCE_ALIASES)) {
      const p = byKey.get(placeKey(name));
      if (p) byKey.set(alias, p);
    }
  }
  return { provinces: byKey, districts: districtKeys };
}

/** The province a name or plate code means, or null. */
export function findProvince(name: string): Province | null {
  return index().provinces.get(placeKey(name)) ?? null;
}

/** The district of `province` a name means, or null. */
export function findDistrict(province: Province, name: string): string | null {
  return index().districts.get(province.name)?.get(placeKey(name)) ?? null;
}

/**
 * A city and district as written in the official list. `invalid_place` with detail `city` when
 * the city isn't one of the 81 provinces, `district` when the district isn't in that province.
 */
export function canonicalPlace(
  city: string,
  district: string,
): Result<{ city: string; district: string }> {
  const province = findProvince(city);
  if (!province) return fail('invalid_place', 'city');
  const found = findDistrict(province, district);
  if (!found) return fail('invalid_place', 'district');
  return ok({ city: province.name, district: found });
}

/**
 * Cron: rewrites stored places and agents' cities that match the list but are written another
 * way. What doesn't match stays as it is and is counted, so staff can see it.
 */
export async function normalisePlaces(
  db: D1Database,
): Promise<{ fixed: number; unmatched: number }> {
  const [places, agents] = await Promise.all([
    db
      .prepare(`SELECT DISTINCT city, district FROM case_places WHERE city != '' LIMIT 2000`)
      .all<{ city: string; district: string }>(),
    db
      .prepare('SELECT DISTINCT city FROM agents WHERE city IS NOT NULL LIMIT 2000')
      .all<{ city: string }>(),
  ]);
  const statements: D1PreparedStatement[] = [];
  let unmatched = 0;
  for (const row of places.results) {
    const found = canonicalPlace(row.city, row.district);
    if (!found.ok) {
      unmatched += 1;
      continue;
    }
    if (found.value.city === row.city && found.value.district === row.district) continue;
    statements.push(
      db
        .prepare('UPDATE case_places SET city = ?, district = ? WHERE city = ? AND district = ?')
        .bind(found.value.city, found.value.district, row.city, row.district),
    );
  }
  for (const row of agents.results) {
    const province = findProvince(row.city);
    if (!province) {
      unmatched += 1;
      continue;
    }
    if (province.name === row.city) continue;
    statements.push(
      db.prepare('UPDATE agents SET city = ? WHERE city = ?').bind(province.name, row.city),
    );
  }
  if (statements.length > 0) await db.batch(statements);
  return { fixed: statements.length, unmatched };
}

/** Places that match nothing in the list, for staff to correct with the company or the agent. */
export async function unmatchedPlaces(
  db: D1Database,
): Promise<{ city: string; district: string; cases: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT city, district, count(DISTINCT case_id) AS cases FROM case_places
       WHERE city != '' GROUP BY city, district LIMIT 2000`,
    )
    .all<{ city: string; district: string; cases: number }>();
  return results.filter((r) => !canonicalPlace(r.city, r.district).ok);
}
