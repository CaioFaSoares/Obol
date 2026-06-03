import { t } from 'elysia';

export const ForecastQueryDTO = t.Object({
  startDate: t.String({ description: 'Formato YYYY-MM-DD' }),
  endDate: t.String({ description: 'Formato YYYY-MM-DD' }),
  includeSimulations: t.Optional(t.String())
});

export const ForecastInvoiceDTO = t.Object({
  card_id: t.String(),
  card_name: t.String(),
  dateStr: t.String(),
  amount: t.Number(),
  status: t.String()
});

export const ForecastResponseDTO = t.Object({
  timeline: t.Array(
    t.Object({
      date: t.String(),
      balance: t.Number()
    })
  ),
  upcomingInvoices: t.Array(ForecastInvoiceDTO)
});
