// ============================================================
// Public API (v1) — deals.
//
// The narrow door a storefront uses to create orders / bookings. It
// never writes to `deals` with an anon key: the integrator holds a
// scoped API key, this module validates everything, and the write goes
// through the service-role client (which bypasses RLS — hence every
// query below filters by `accountId` explicitly).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { DEFAULT_CURRENCY } from '@/lib/currency';
import { slugifyKey } from '@/lib/custom-fields/slug';
import {
  ContactError,
  findOrCreateContact,
  resolveAuditUserId,
} from './contacts';
import { ApiError, badRequest } from './respond';

// ---------- wire shape ----------

export interface ApiDeal {
  id: string;
  external_id: string | null;
  title: string;
  value: number;
  currency: string;
  status: 'open' | 'won' | 'lost';
  notes: string | null;
  expected_close_date: string | null;
  details: Record<string, unknown>;
  /** Typed per-vertical attributes, keyed by normalised field name. */
  fields: Record<string, string>;
  pipeline_id: string;
  stage: { id: string; name: string } | null;
  contact: { id: string; name: string | null; phone: string } | null;
  created_at: string;
  updated_at: string;
}

export const DEAL_SELECT =
  'id, external_id, title, value, currency, status, notes, expected_close_date, details, pipeline_id, created_at, updated_at, ' +
  'stage:pipeline_stages(id, name), contact:contacts(id, name, phone), ' +
  'deal_custom_values(value, field:custom_fields(field_name))';

/** A to-one embed arrives as an object or a one-element array. */
function one(rel: unknown): Record<string, unknown> | null {
  const row = Array.isArray(rel) ? rel[0] : rel;
  return row && typeof row === 'object'
    ? (row as Record<string, unknown>)
    : null;
}

export function serializeDeal(row: Record<string, unknown>): ApiDeal {
  const stage = one(row.stage);
  const contact = one(row.contact);

  const fields: Record<string, string> = {};
  const values = Array.isArray(row.deal_custom_values)
    ? (row.deal_custom_values as Array<Record<string, unknown>>)
    : [];
  for (const v of values) {
    const name = one(v.field)?.field_name;
    if (typeof name === 'string' && v.value != null) {
      fields[slugifyKey(name)] = String(v.value);
    }
  }

  return {
    id: row.id as string,
    external_id: (row.external_id as string | null) ?? null,
    title: row.title as string,
    value: Number(row.value ?? 0),
    currency: (row.currency as string) ?? DEFAULT_CURRENCY,
    status: (row.status as ApiDeal['status']) ?? 'open',
    notes: (row.notes as string | null) ?? null,
    expected_close_date: (row.expected_close_date as string | null) ?? null,
    details: (row.details as Record<string, unknown>) ?? {},
    fields,
    pipeline_id: row.pipeline_id as string,
    stage: stage
      ? { id: stage.id as string, name: stage.name as string }
      : null,
    contact: contact
      ? {
          id: contact.id as string,
          name: (contact.name as string | null) ?? null,
          phone: contact.phone as string,
        }
      : null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ---------- input validation ----------

export interface CreateDealInput {
  contact:
    | { kind: 'id'; id: string }
    | {
        kind: 'phone';
        phone: string;
        name?: string;
        email?: string;
        company?: string;
      };
  pipelineId?: string;
  stageId?: string;
  title: string;
  value: number;
  currency?: string;
  notes: string | null;
  expectedCloseDate: string | null;
  details: Record<string, unknown>;
  /** Normalised field name -> text value. Blank values are dropped. */
  fields: Record<string, string>;
  externalId: string | null;
}

const ALLOWED_KEYS = [
  'contact',
  'contact_id',
  'pipeline_id',
  'stage_id',
  'title',
  'value',
  'currency',
  'notes',
  'expected_close_date',
  'details',
  'fields',
  'external_id',
] as const;

const CONTACT_KEYS = ['phone', 'name', 'email', 'company'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TITLE = 200;
const MAX_NOTES = 5000;
const MAX_EXTERNAL_ID = 200;
const MAX_FIELD_VALUE = 2000;
const MAX_DETAILS_BYTES = 32 * 1024;
/** deals.value is NUMERIC(12,2). */
const MAX_VALUE = 9_999_999_999.99;

/**
 * Any real ISO-4217 code, not just the ones the dashboard picker offers:
 * the schema deliberately accepts any 3-letter code ("forks can use any
 * currency Intl supports") and the formatters cope with all of them.
 * `Intl` knows the real list, so use it; if a runtime lacks it, fall back
 * to the shape check alone rather than rejecting everything.
 */
function isIsoCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  try {
    return Intl.supportedValuesOf('currency').includes(code);
  } catch {
    return true;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function str(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string') throw badRequest(`'${name}' must be a string`);
  const trimmed = v.trim();
  if (trimmed.length > max) {
    throw badRequest(`'${name}' must be at most ${max} characters`);
  }
  return trimmed;
}

function uuid(v: unknown, name: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) {
    throw badRequest(`'${name}' must be a valid id`);
  }
  return v;
}

function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseCreateDeal(body: unknown): CreateDealInput {
  if (!isPlainObject(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  // Strict on purpose: a typo like `valor` for `value` must fail loudly
  // rather than silently create a deal worth 0.
  const unknown = Object.keys(body).filter(
    (k) => !(ALLOWED_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) {
    throw badRequest(
      `Unknown field(s): ${unknown.join(', ')}. Allowed: ${ALLOWED_KEYS.join(', ')}`
    );
  }

  // --- contact: exactly one of `contact` / `contact_id` ---
  const hasContact = present(body.contact);
  const hasContactId = present(body.contact_id);
  if (hasContact === hasContactId) {
    throw badRequest("Provide exactly one of 'contact' or 'contact_id'");
  }
  let contact: CreateDealInput['contact'];
  if (hasContactId) {
    contact = { kind: 'id', id: uuid(body.contact_id, 'contact_id') };
  } else {
    if (!isPlainObject(body.contact)) {
      throw badRequest("'contact' must be an object");
    }
    const badKeys = Object.keys(body.contact).filter(
      (k) => !(CONTACT_KEYS as readonly string[]).includes(k)
    );
    if (badKeys.length > 0) {
      throw badRequest(
        `Unknown contact field(s): ${badKeys.join(', ')}. Allowed: ${CONTACT_KEYS.join(', ')}`
      );
    }
    const phone = str(body.contact.phone ?? '', 'contact.phone', 40);
    if (!phone) throw badRequest("'contact.phone' is required");
    contact = { kind: 'phone', phone };
    if (present(body.contact.name)) {
      contact.name = str(body.contact.name, 'contact.name', 200);
    }
    if (present(body.contact.email)) {
      contact.email = str(body.contact.email, 'contact.email', 320);
    }
    if (present(body.contact.company)) {
      contact.company = str(body.contact.company, 'contact.company', 200);
    }
  }

  // --- where the deal goes ---
  const pipelineId = present(body.pipeline_id)
    ? uuid(body.pipeline_id, 'pipeline_id')
    : undefined;
  const stageId = present(body.stage_id)
    ? uuid(body.stage_id, 'stage_id')
    : undefined;
  if (!pipelineId && !stageId) {
    throw badRequest("Provide 'pipeline_id' or 'stage_id'");
  }

  // --- title / value / currency ---
  const title = str(body.title ?? '', 'title', MAX_TITLE);
  if (!title) throw badRequest("'title' is required");

  let value = 0;
  if (present(body.value)) {
    const v = body.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw badRequest("'value' must be a number");
    }
    if (v < 0 || v > MAX_VALUE) {
      throw badRequest(`'value' must be between 0 and ${MAX_VALUE}`);
    }
    // NUMERIC(12,2) would round silently; refuse instead of altering money.
    if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) {
      throw badRequest("'value' can have at most 2 decimal places");
    }
    value = v;
  }

  let currency: string | undefined;
  if (present(body.currency)) {
    currency = str(body.currency, 'currency', 3).toUpperCase();
    if (!isIsoCurrency(currency)) {
      throw badRequest(`'currency' ${currency} is not a valid ISO 4217 code`);
    }
  }

  // --- optional text / date ---
  const notes = present(body.notes)
    ? str(body.notes, 'notes', MAX_NOTES) || null
    : null;

  let expectedCloseDate: string | null = null;
  if (present(body.expected_close_date)) {
    const d = str(body.expected_close_date, 'expected_close_date', 10);
    if (!isRealDate(d)) {
      throw badRequest(
        "'expected_close_date' must be a valid date (YYYY-MM-DD)"
      );
    }
    expectedCloseDate = d;
  }

  // --- details: free-form object, size-capped ---
  let details: Record<string, unknown> = {};
  if (present(body.details)) {
    if (!isPlainObject(body.details)) {
      throw badRequest("'details' must be a JSON object");
    }
    if (
      Buffer.byteLength(JSON.stringify(body.details), 'utf8') >
      MAX_DETAILS_BYTES
    ) {
      throw badRequest(
        `'details' must be at most ${MAX_DETAILS_BYTES / 1024} KB`
      );
    }
    details = body.details;
  }

  // --- fields: typed attributes by (normalised) name ---
  const fields: Record<string, string> = {};
  if (present(body.fields)) {
    if (!isPlainObject(body.fields)) {
      throw badRequest("'fields' must be an object");
    }
    for (const [rawKey, raw] of Object.entries(body.fields)) {
      const key = slugifyKey(rawKey);
      if (!key) throw badRequest(`'fields' has an invalid name: "${rawKey}"`);
      if (key in fields) {
        throw badRequest(`'fields' has two entries for "${key}"`);
      }
      if (raw === null || raw === undefined) continue;
      if (
        typeof raw !== 'string' &&
        typeof raw !== 'boolean' &&
        !(typeof raw === 'number' && Number.isFinite(raw))
      ) {
        throw badRequest(
          `'fields.${key}' must be text, a number or true/false`
        );
      }
      const text = String(raw).trim();
      if (text.length > MAX_FIELD_VALUE) {
        throw badRequest(
          `'fields.${key}' must be at most ${MAX_FIELD_VALUE} characters`
        );
      }
      // Blank = "no value", same as leaving it out.
      if (text) fields[key] = text;
    }
  }

  const externalId = present(body.external_id)
    ? str(body.external_id, 'external_id', MAX_EXTERNAL_ID)
    : null;
  if (present(body.external_id) && !externalId) {
    throw badRequest("'external_id' must not be empty");
  }

  return {
    contact,
    pipelineId,
    stageId,
    title,
    value,
    currency,
    notes,
    expectedCloseDate,
    details,
    fields,
    externalId,
  };
}

// ---------- reads ----------

export async function getDealById(
  db: SupabaseClient,
  accountId: string,
  dealId: string
): Promise<ApiDeal | null> {
  const { data, error } = await db
    .from('deals')
    .select(DEAL_SELECT)
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/deals] read error:', error);
    throw new ApiError('internal', 'Failed to read deal', 500);
  }
  return data
    ? serializeDeal(data as unknown as Record<string, unknown>)
    : null;
}

async function getDealByExternalId(
  db: SupabaseClient,
  accountId: string,
  externalId: string
): Promise<ApiDeal | null> {
  const { data, error } = await db
    .from('deals')
    .select(DEAL_SELECT)
    .eq('account_id', accountId)
    .eq('external_id', externalId)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/deals] external_id lookup error:', error);
    throw new ApiError('internal', 'Failed to look up deal', 500);
  }
  return data
    ? serializeDeal(data as unknown as Record<string, unknown>)
    : null;
}

// ---------- create ----------

async function resolveContactId(
  db: SupabaseClient,
  accountId: string,
  contact: CreateDealInput['contact']
): Promise<string> {
  if (contact.kind === 'id') {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('id', contact.id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!data) throw badRequest("'contact_id' does not exist");
    return data.id as string;
  }

  try {
    const auditUserId = await resolveAuditUserId(db, accountId);
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: contact.phone,
      name: contact.name,
      email: contact.email,
      company: contact.company,
    });
    return id;
  } catch (err) {
    if (err instanceof ContactError) {
      if (err.status === 400) throw badRequest(err.message);
      throw new ApiError('internal', err.message, 500);
    }
    throw err;
  }
}

/** The stage the deal lands in, and the pipeline it belongs to. */
async function resolvePlacement(
  db: SupabaseClient,
  accountId: string,
  input: Pick<CreateDealInput, 'pipelineId' | 'stageId'>
): Promise<{ pipelineId: string; stageId: string }> {
  if (input.stageId) {
    // A stage has no account of its own; it belongs to one through its
    // pipeline, so that is what the account filter has to go through.
    const { data } = await db
      .from('pipeline_stages')
      .select('id, pipeline_id, pipelines!inner(account_id)')
      .eq('id', input.stageId)
      .eq('pipelines.account_id', accountId)
      .maybeSingle();
    if (!data) throw badRequest("'stage_id' does not exist");
    const pipelineId = data.pipeline_id as string;
    if (input.pipelineId && input.pipelineId !== pipelineId) {
      throw badRequest("'stage_id' does not belong to 'pipeline_id'");
    }
    return { pipelineId, stageId: input.stageId };
  }

  const pipelineId = input.pipelineId as string;
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('id', pipelineId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!pipeline) throw badRequest("'pipeline_id' does not exist");

  const { data: first } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!first) throw badRequest('That pipeline has no stages');
  return { pipelineId, stageId: first.id as string };
}

/** Map normalised field names to this account's deal-field ids. */
async function resolveFieldRows(
  db: SupabaseClient,
  accountId: string,
  fields: Record<string, string>
): Promise<Array<{ custom_field_id: string; value: string }>> {
  const keys = Object.keys(fields);
  if (keys.length === 0) return [];

  const { data, error } = await db
    .from('custom_fields')
    .select('id, field_name')
    .eq('account_id', accountId)
    .eq('entity_type', 'deal');
  if (error) {
    console.error('[api/v1/deals] custom_fields error:', error);
    throw new ApiError('internal', 'Failed to resolve fields', 500);
  }

  const idByKey = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; field_name: string }>) {
    const key = slugifyKey(row.field_name);
    if (key && !idByKey.has(key)) idByKey.set(key, row.id);
  }

  const missing = keys.filter((k) => !idByKey.has(k));
  if (missing.length > 0) {
    throw badRequest(
      `Unknown deal field(s): ${missing.join(', ')}. Create them in Settings → Fields & tags first.`
    );
  }
  return keys.map((k) => ({
    custom_field_id: idByKey.get(k) as string,
    value: fields[k],
  }));
}

async function defaultCurrency(
  db: SupabaseClient,
  accountId: string
): Promise<string> {
  const { data } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', accountId)
    .maybeSingle();
  return (data?.default_currency as string | undefined) ?? DEFAULT_CURRENCY;
}

/** Best-effort compensation: supabase-js offers no multi-table transaction. */
async function removeDeal(
  db: SupabaseClient,
  accountId: string,
  dealId: string
): Promise<void> {
  const { error } = await db
    .from('deals')
    .delete()
    .eq('id', dealId)
    .eq('account_id', accountId);
  if (error) {
    console.error('[api/v1/deals] rollback failed for deal', dealId, error);
  }
}

/**
 * Create a deal (or return the one already created for the same
 * `external_id`). `created` is false on a replay, so the caller can
 * answer 200 instead of 201.
 */
export async function createDeal(
  db: SupabaseClient,
  accountId: string,
  input: CreateDealInput
): Promise<{ deal: ApiDeal; created: boolean }> {
  // Replays first: a retry must never create a second order, and must
  // not create a stray contact either.
  if (input.externalId) {
    const existing = await getDealByExternalId(db, accountId, input.externalId);
    if (existing) return { deal: existing, created: false };
  }

  // Everything that can be wrong with the input is checked before the
  // first write, so the common failure leaves nothing behind.
  const placement = await resolvePlacement(db, accountId, input);
  const fieldRows = await resolveFieldRows(db, accountId, input.fields);
  const currency = input.currency ?? (await defaultCurrency(db, accountId));
  const contactId = await resolveContactId(db, accountId, input.contact);
  const auditUserId = await resolveAuditUserId(db, accountId);

  const { data: inserted, error } = await db
    .from('deals')
    .insert({
      account_id: accountId,
      user_id: auditUserId,
      contact_id: contactId,
      pipeline_id: placement.pipelineId,
      stage_id: placement.stageId,
      title: input.title,
      value: input.value,
      currency,
      status: 'open',
      notes: input.notes,
      expected_close_date: input.expectedCloseDate,
      details: input.details,
      external_id: input.externalId,
    })
    .select('id')
    .single();

  if (error || !inserted) {
    // Lost a race against a concurrent request with the same external_id:
    // the unique index rejected us, so hand back the winner.
    if (input.externalId && isUniqueViolation(error)) {
      const raced = await getDealByExternalId(db, accountId, input.externalId);
      if (raced) return { deal: raced, created: false };
    }
    console.error('[api/v1/deals] create error:', error);
    throw new ApiError('internal', 'Failed to create deal', 500);
  }
  const dealId = inserted.id as string;

  if (fieldRows.length > 0) {
    const { error: valuesError } = await db
      .from('deal_custom_values')
      .insert(fieldRows.map((r) => ({ deal_id: dealId, ...r })));
    if (valuesError) {
      console.error('[api/v1/deals] field values error:', valuesError);
      await removeDeal(db, accountId, dealId);
      throw new ApiError('internal', 'Failed to create deal', 500);
    }
  }

  const deal = await getDealById(db, accountId, dealId);
  if (!deal) throw new ApiError('internal', 'Failed to read created deal', 500);
  return { deal, created: true };
}
