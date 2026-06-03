import { t } from 'elysia';

export const ProjectCreateDTO = t.Object({
  name: t.String(),
  total_value: t.Numeric({ minimum: 0 }),
});

export const ProjectPaymentDTO = t.Object({
  amount: t.Numeric({ minimum: 0.01 }),
  description: t.Optional(t.String()),
});
