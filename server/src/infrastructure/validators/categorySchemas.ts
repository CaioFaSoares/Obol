import { t } from 'elysia';

export const CategoryDTO = t.Object({
  name: t.String(),
  type: t.Union([t.Literal('fixed_budget'), t.Literal('variable')]),
  monthly_budget: t.Optional(t.Numeric()),
});
