import { t } from 'elysia';

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
