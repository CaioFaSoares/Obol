import { t } from 'elysia';

// Create body. Null-free: a create request omits an unset optional field.
export const TransactionDTO = t.Object({
  title: t.String(),
  amount: t.Numeric({ minimum: 0.01 }),
  type: t.Union([t.Literal('income'), t.Literal('expense'), t.Literal('transfer')]),
  status: t.Union([t.Literal('pending'), t.Literal('realized')]),
  expected_date: t.String({ format: 'date-time' }), // IsoString YYYY-MM-DD...
  realized_date: t.Optional(t.String({ format: 'date-time' })),
  is_recurring: t.Optional(t.Boolean()),
  is_silent: t.Optional(t.Boolean()),
  is_simulated: t.Optional(t.Boolean({ default: false })),
  is_scheduled: t.Optional(t.Boolean({ default: false })),
  purchase_date: t.Optional(t.String({ format: 'date-time' })),
  
  account_id: t.Optional(t.String()),
  card_id: t.Optional(t.String()),
  category_id: t.Optional(t.String()),
  project_id: t.Optional(t.String()),
  destination_account_id: t.Optional(t.String())
});

// PATCH body. An omitted field keeps the stored value; `null` clears a
// canonical optional relation or date. `invoice_id` and `recurrence_id` are
// never accepted from a client patch: invoice routing is computed by the use
// case and the recurrence link is create-only.
export const TransactionUpdatePatchDTO = t.Object({
  title: t.Optional(t.String()),
  amount: t.Optional(t.Numeric({ minimum: 0.01 })),
  type: t.Optional(t.Union([t.Literal('income'), t.Literal('expense'), t.Literal('transfer')])),
  status: t.Optional(t.Union([t.Literal('pending'), t.Literal('realized')])),
  expected_date: t.Optional(t.String({ format: 'date-time' })),
  realized_date: t.Optional(t.Union([t.String({ format: 'date-time' }), t.Null()])),
  is_recurring: t.Optional(t.Boolean()),
  is_silent: t.Optional(t.Boolean()),
  is_simulated: t.Optional(t.Boolean()),
  is_scheduled: t.Optional(t.Boolean()),
  purchase_date: t.Optional(t.Union([t.String({ format: 'date-time' }), t.Null()])),
  account_id: t.Optional(t.Union([t.String(), t.Null()])),
  card_id: t.Optional(t.Union([t.String(), t.Null()])),
  category_id: t.Optional(t.Union([t.String(), t.Null()])),
  project_id: t.Optional(t.Union([t.String(), t.Null()])),
  destination_account_id: t.Optional(t.Union([t.String(), t.Null()]))
});
