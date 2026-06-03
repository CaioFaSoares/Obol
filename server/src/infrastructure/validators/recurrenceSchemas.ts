import { t } from 'elysia';

export const RecurrenceDTO = t.Object({
  name: t.String(),
  amount: t.Numeric({ minimum: 0.01 }),
  payday: t.Numeric({ minimum: 1, maximum: 31 }),
  type: t.Union([t.Literal('income'), t.Literal('expense')]),
  account_id: t.Optional(t.String()),
  card_id: t.Optional(t.String()),
  category_id: t.Optional(t.String()),
  end_date: t.Optional(t.String()),
  total_installments: t.Optional(t.Number()),
  skipped_periods: t.Optional(t.Array(t.String())),
});
