import { t } from 'elysia';

export const TransactionDTO = t.Object({
  title: t.String(),
  amount: t.Number({ minimum: 0.01 }),
  type: t.Union([t.Literal('income'), t.Literal('expense'), t.Literal('transfer')]),
  status: t.Union([t.Literal('pending'), t.Literal('realized')]),
  expected_date: t.String({ format: 'date-time' }), // IsoString YYYY-MM-DD...
  realized_date: t.Optional(t.String({ format: 'date-time' })),
  is_recurring: t.Optional(t.Boolean()),
  
  // IDs de relacionamento
  account_id: t.Optional(t.String()),
  card_id: t.Optional(t.String()),
  category_id: t.Optional(t.String()),
  project_id: t.Optional(t.String())
});

// Validamos a query string
export const ForecastQueryDTO = t.Object({
  startDate: t.String({ description: 'Formato YYYY-MM-DD' }),
  endDate: t.String({ description: 'Formato YYYY-MM-DD' })
});

// Definimos a resposta exata para o Nuxt receber com autocomplete
export const ForecastResponseDTO = t.Array(
  t.Object({
    date: t.String(),
    balance: t.Number()
  })
);
