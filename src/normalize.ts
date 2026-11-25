/**
 * Vehicle identity (docs/DESIGN.md §4.2). The VIN (şasi no, ISO 3779) is who a vehicle is; the
 * plate is where it is registered now. Both are compared only in these normal forms.
 */

/** 17 characters, digits and capitals without I, O and Q. Spaces and dashes are dropped. */
export function normalizeVin(input: string): string | null {
  const vin = input.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null;
}

/**
 * A Turkish plate: province code 01–81, one to three letters, two to four digits ("34 ABC 123"
 * becomes "34ABC123"). Turkish letters (Ç, Ğ, İ, Ö, Ş, Ü) never appear on plates.
 */
export function normalizePlate(input: string): string | null {
  const plate = input.replace(/[\s-]/g, '').toLocaleUpperCase('tr-TR').replace(/İ/g, 'I');
  const match = /^(\d{2})([A-Z]{1,3})(\d{2,4})$/.exec(plate);
  if (!match) return null;
  const province = Number(match[1]);
  if (province < 1 || province > 81) return null;
  return plate;
}

/** For display: "34ABC123" → "34 ABC 123". */
export function formatPlate(plate: string): string {
  const match = /^(\d{2})([A-Z]{1,3})(\d{2,4})$/.exec(plate);
  return match ? `${match[1] ?? ''} ${match[2] ?? ''} ${match[3] ?? ''}` : plate;
}
