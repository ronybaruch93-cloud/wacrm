/**
 * Custom field names are free text ("Fecha límite"), but both the
 * automation template syntax (`{{ deal.field.fecha_limite }}`) and the
 * public API (`"fields": { "fecha_limite": "…" }`) address them by a
 * normalised key. Keeping the rule in one place is what guarantees the
 * two agree.
 *
 * Lower-case, accents stripped, every run of anything other than
 * letters/digits collapsed to a single underscore, no leading or
 * trailing underscore.
 */
export function slugifyKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
