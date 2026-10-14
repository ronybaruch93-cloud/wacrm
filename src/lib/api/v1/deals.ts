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

import type { DispatchInput } from '@/lib/automations/engine';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { DEFAULT_CURRENCY } from '@/lib/currency';
import { slugifyKey } from '@/lib/custom-fields/slug';
import { DealStageError, moveDealStage } from '@/lib/deals/stage-events';
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

// Field validators shared by create and update, so the two can never
// drift apart on what a valid title / value / currency / ... is.

function parseTitle(v: unknown): string {
  const title = str(v, 'title', MAX_TITLE);
  if (!title) throw badRequest("'title' is required");
  return title;
}

function parseValue(v: unknown): number {
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
  return v;
}

function parseCurrency(v: unknown): string {
  const currency = str(v, 'currency', 3).toUpperCase();
  if (!isIsoCurrency(currency)) {
    throw badRequest(`'currency' ${currency} is not a valid ISO 4217 code`);
  }
  return currency;
}

function parseExpectedCloseDate(v: unknown): string {
  const d = str(v, 'expected_close_date', 10);
  if (!isRealDate(d)) {
    throw badRequest("'expected_close_date' must be a valid date (YYYY-MM-DD)");
  }
  return d;
}

function parseDetails(v: unknown): Record<string, unknown> {
  if (!isPlainObject(v)) throw badRequest("'details' must be a JSON object");
  if (Buffer.byteLength(JSON.stringify(v), 'utf8') > MAX_DETAILS_BYTES) {
    throw badRequest(
      `'details' must be at most ${MAX_DETAILS_BYTES / 1024} KB`
    );
  }
  return v;
}

/**
 * Typed attributes by (normalised) name. A `null` entry means "no value":
 * create drops it, update uses it to clear a field. Blank text counts the
 * same as null.
 */
function parseFields(v: unknown): Record<string, string | null> {
  if (!isPlainObject(v)) throw badRequest("'fields' must be an object");
  const fields: Record<string, string | null> = {};
  for (const [rawKey, raw] of Object.entries(v)) {
    const key = slugifyKey(rawKey);
    if (!key) throw badRequest(`'fields' has an invalid name: "${rawKey}"`);
    if (key in fields) {
      throw badRequest(`'fields' has two entries for "${key}"`);
    }
    if (raw === null || raw === undefined) {
      fields[key] = null;
      continue;
    }
    if (
      typeof raw !== 'string' &&
      typeof raw !== 'boolean' &&
      !(typeof raw === 'number' && Number.isFinite(raw))
    ) {
      throw badRequest(`'fields.${key}' must be text, a number or true/false`);
    }
    const text = String(raw).trim();
    if (text.length > MAX_FIELD_VALUE) {
      throw badRequest(
        `'fields.${key}' must be at most ${MAX_FIELD_VALUE} characters`
      );
    }
    fields[key] = text || null;
  }
  return fields;
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

  const externalId = present(body.external_id)
    ? str(body.external_id, 'external_id', MAX_EXTERNAL_ID)
    : null;
  if (present(body.external_id) && !externalId) {
    throw badRequest("'external_id' must not be empty");
  }

  // Create treats null as "not sent" for every optional field.
  const parsedFields = present(body.fields) ? parseFields(body.fields) : {};
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsedFields)) {
    if (value !== null) fields[key] = value;
  }

  return {
    contact,
    pipelineId,
    stageId,
    title: parseTitle(body.title ?? ''),
    value: present(body.value) ? parseValue(body.value) : 0,
    currency: present(body.currency) ? parseCurrency(body.currency) : undefined,
    notes: present(body.notes)
      ? str(body.notes, 'notes', MAX_NOTES) || null
      : null,
    expectedCloseDate: present(body.expected_close_date)
      ? parseExpectedCloseDate(body.expected_close_date)
      : null,
    details: present(body.details) ? parseDetails(body.details) : {},
    fields,
    externalId,
  };
}

// ---------- update input ----------

export interface UpdateDealInput {
  title?: string;
  value?: number;
  currency?: string;
  /** null clears it. */
  notes?: string | null;
  /** null clears it. */
  expectedCloseDate?: string | null;
  status?: ApiDeal['status'];
  /** Replaces the whole object. */
  details?: Record<string, unknown>;
  /** Normalised name -> value; null clears that field. */
  fields?: Record<string, string | null>;
  stageId?: string;
}

const UPDATE_KEYS = [
  'title',
  'value',
  'currency',
  'notes',
  'expected_close_date',
  'status',
  'details',
  'fields',
  'stage_id',
] as const;

/** Set when the deal is created and never changed through the API. */
const IMMUTABLE_KEYS = [
  'contact',
  'contact_id',
  'pipeline_id',
  'external_id',
] as const;

const STATUSES: ReadonlyArray<ApiDeal['status']> = ['open', 'won', 'lost'];

export function parseUpdateDeal(body: unknown): UpdateDealInput {
  if (!isPlainObject(body)) {
    throw badRequest('Request body must be a JSON object');
  }

  const immutable = Object.keys(body).filter((k) =>
    (IMMUTABLE_KEYS as readonly string[]).includes(k)
  );
  if (immutable.length > 0) {
    throw badRequest(
      `${immutable.join(', ')} cannot be changed after the deal is created`
    );
  }
  const unknown = Object.keys(body).filter(
    (k) => !(UPDATE_KEYS as readonly string[]).includes(k)
  );
  if (unknown.length > 0) {
    throw badRequest(
      `Unknown field(s): ${unknown.join(', ')}. Allowed: ${UPDATE_KEYS.join(', ')}`
    );
  }

  // Fields that cannot be cleared must not be sent as null: ignoring it
  // silently would hide the caller's mistake.
  const notNull = (key: (typeof UPDATE_KEYS)[number]) => {
    if (body[key] === null) throw badRequest(`'${key}' cannot be null`);
  };

  const input: UpdateDealInput = {};

  if (body.title !== undefined) {
    notNull('title');
    input.title = parseTitle(body.title);
  }
  if (body.value !== undefined) {
    notNull('value');
    input.value = parseValue(body.value);
  }
  if (body.currency !== undefined) {
    notNull('currency');
    input.currency = parseCurrency(body.currency);
  }
  if (body.notes !== undefined) {
    input.notes =
      body.notes === null ? null : str(body.notes, 'notes', MAX_NOTES) || null;
  }
  if (body.expected_close_date !== undefined) {
    input.expectedCloseDate =
      body.expected_close_date === null
        ? null
        : parseExpectedCloseDate(body.expected_close_date);
  }
  if (body.status !== undefined) {
    notNull('status');
    if (!STATUSES.includes(body.status as ApiDeal['status'])) {
      throw badRequest(`'status' must be one of ${STATUSES.join(', ')}`);
    }
    input.status = body.status as ApiDeal['status'];
  }
  if (body.details !== undefined) {
    notNull('details');
    input.details = parseDetails(body.details);
  }
  if (body.fields !== undefined) {
    notNull('fields');
    const fields = parseFields(body.fields);
    if (Object.keys(fields).length > 0) input.fields = fields;
  }
  if (body.stage_id !== undefined) {
    notNull('stage_id');
    input.stageId = uuid(body.stage_id, 'stage_id');
  }

  if (Object.keys(input).length === 0) {
    throw badRequest('Nothing to update: send at least one field');
  }
  return input;
}

/**
 * A deal id from the URL. Anything that is not a well-formed id cannot
 * exist, so it is a 404 — passing it to the database would be a type
 * error there and surface as a 500.
 */
export function parseDealId(raw: string): string {
  if (!UUID.test(raw)) throw new ApiError('not_found', 'Deal not found', 404);
  return raw;
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

/**
 * Map normalised field names to this account's deal-field ids. Unknown
 * names are rejected, naming them, before anything is written.
 */
async function resolveFieldIds(
  db: SupabaseClient,
  accountId: string,
  keys: string[]
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();

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
  return idByKey;
}

async function resolveFieldRows(
  db: SupabaseClient,
  accountId: string,
  fields: Record<string, string>
): Promise<Array<{ custom_field_id: string; value: string }>> {
  const keys = Object.keys(fields);
  const idByKey = await resolveFieldIds(db, accountId, keys);
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

// ---------- update ----------

function dealStageErrorToApiError(err: DealStageError): ApiError {
  if (err.status === 404) return new ApiError('not_found', err.message, 404);
  if (err.status === 400) return badRequest(err.message);
  return new ApiError('internal', err.message, 500);
}

/**
 * Update a deal. Everything that can be wrong with the input is checked
 * before the first write. The stage moves LAST, so any customer
 * notification a `deal_stage_changed` automation sends goes out after the
 * rest of the deal has been saved. The returned `event` (null when the
 * stage did not actually change) is for the caller to dispatch once the
 * response has been sent.
 */
export async function updateDeal(
  db: SupabaseClient,
  accountId: string,
  dealId: string,
  input: UpdateDealInput
): Promise<{ deal: ApiDeal; event: DispatchInput | null }> {
  const { data: existing, error: existingError } = await db
    .from('deals')
    .select('id, pipeline_id')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (existingError) {
    console.error('[api/v1/deals] update lookup error:', existingError);
    throw new ApiError('internal', 'Failed to update deal', 500);
  }
  // 404 also covers a deal of another account: never reveal it exists.
  if (!existing) throw new ApiError('not_found', 'Deal not found', 404);

  if (input.stageId) {
    const { data: stage } = await db
      .from('pipeline_stages')
      .select('id')
      .eq('id', input.stageId)
      .eq('pipeline_id', existing.pipeline_id as string)
      .maybeSingle();
    if (!stage) {
      throw badRequest("'stage_id' does not belong to this deal's pipeline");
    }
  }

  const fieldKeys = input.fields ? Object.keys(input.fields) : [];
  const fieldIds = await resolveFieldIds(db, accountId, fieldKeys);

  const columns: Record<string, unknown> = {};
  if (input.title !== undefined) columns.title = input.title;
  if (input.value !== undefined) columns.value = input.value;
  if (input.currency !== undefined) columns.currency = input.currency;
  if (input.notes !== undefined) columns.notes = input.notes;
  if (input.expectedCloseDate !== undefined) {
    columns.expected_close_date = input.expectedCloseDate;
  }
  if (input.status !== undefined) columns.status = input.status;
  if (input.details !== undefined) columns.details = input.details;

  if (Object.keys(columns).length > 0) {
    const { error } = await db
      .from('deals')
      .update(columns)
      .eq('id', dealId)
      .eq('account_id', accountId);
    if (error) {
      console.error('[api/v1/deals] update error:', error);
      throw new ApiError('internal', 'Failed to update deal', 500);
    }
  }

  if (input.fields) {
    const upserts: Array<{
      deal_id: string;
      custom_field_id: string;
      value: string;
    }> = [];
    const clears: string[] = [];
    for (const [key, value] of Object.entries(input.fields)) {
      const customFieldId = fieldIds.get(key) as string;
      if (value === null) clears.push(customFieldId);
      else
        upserts.push({
          deal_id: dealId,
          custom_field_id: customFieldId,
          value,
        });
    }

    if (upserts.length > 0) {
      const { error } = await db
        .from('deal_custom_values')
        .upsert(upserts, { onConflict: 'deal_id,custom_field_id' });
      if (error) {
        console.error('[api/v1/deals] field upsert error:', error);
        throw new ApiError('internal', 'Failed to update deal', 500);
      }
    }
    if (clears.length > 0) {
      const { error } = await db
        .from('deal_custom_values')
        .delete()
        .eq('deal_id', dealId)
        .in('custom_field_id', clears);
      if (error) {
        console.error('[api/v1/deals] field clear error:', error);
        throw new ApiError('internal', 'Failed to update deal', 500);
      }
    }
  }

  let event: DispatchInput | null = null;
  if (input.stageId) {
    try {
      const moved = await moveDealStage({
        db,
        accountId,
        dealId,
        toStageId: input.stageId,
      });
      event = moved.event;
    } catch (err) {
      if (err instanceof DealStageError) throw dealStageErrorToApiError(err);
      throw err;
    }
  }

  const deal = await getDealById(db, accountId, dealId);
  if (!deal) throw new ApiError('not_found', 'Deal not found', 404);
  return { deal, event };
}
