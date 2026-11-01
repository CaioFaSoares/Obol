import { t } from 'elysia';

// Create body. Null-free: a create request omits an unset optional field.
export const RecurrenceDTO = t.Object({
  name: t.String(),
  amount: t.Numeric({ minimum: 0.01 }),
  payday: t.Numeric({ minimum: 1, maximum: 31 }),
  type: t.Union([t.Literal('income'), t.Literal('expense')]),
  frequency: t.Optional(t.Union([t.Literal('monthly'), t.Literal('weekly')])),
  weekday: t.Optional(t.Numeric({ minimum: 1, maximum: 7 })),
  account_id: t.Optional(t.String()),
  card_id: t.Optional(t.String()),
  category_id: t.Optional(t.String()),
  end_date: t.Optional(t.String()),
  total_installments: t.Optional(t.Number()),
  skipped_periods: t.Optional(t.Array(t.String())),
});

// Update body. An omitted field keeps the stored value; `null` clears a
// canonical optional relation or date. `status` stays outside the patch: the
// toggle, launch and expiry paths own it.
export const RecurrenceUpdatePatchDTO = t.Object({
  name: t.Optional(t.String()),
  amount: t.Optional(t.Numeric({ minimum: 0.01 })),
  payday: t.Optional(t.Numeric({ minimum: 1, maximum: 31 })),
  type: t.Optional(t.Union([t.Literal('income'), t.Literal('expense')])),
  frequency: t.Optional(t.Union([t.Literal('monthly'), t.Literal('weekly'), t.Null()])),
  weekday: t.Optional(t.Union([t.Numeric({ minimum: 1, maximum: 7 }), t.Null()])),
  account_id: t.Optional(t.Union([t.String(), t.Null()])),
  card_id: t.Optional(t.Union([t.String(), t.Null()])),
  category_id: t.Optional(t.Union([t.String(), t.Null()])),
  end_date: t.Optional(t.Union([t.String(), t.Null()])),
  total_installments: t.Optional(t.Union([t.Number(), t.Null()])),
  skipped_periods: t.Optional(t.Array(t.String())),
});
