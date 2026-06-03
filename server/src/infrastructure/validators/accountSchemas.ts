import { t } from 'elysia';

export const AccountDTO = t.Object({
  name: t.String(),
  type: t.Union([t.Literal('checking'), t.Literal('savings'), t.Literal('investment')]),
  initial_balance: t.Numeric(),
});
