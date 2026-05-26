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
  // Data original da compra (para cartões de crédito)
  purchase_date: t.Optional(t.String({ format: 'date-time' })),
  
  // IDs de relacionamento
  account_id: t.Optional(t.String()),
  card_id: t.Optional(t.String()),
  category_id: t.Optional(t.String()),
  project_id: t.Optional(t.String()),
  destination_account_id: t.Optional(t.String())
});

// Validamos a query string
export const ForecastQueryDTO = t.Object({
  startDate: t.String({ description: 'Formato YYYY-MM-DD' }),
  endDate: t.String({ description: 'Formato YYYY-MM-DD' })
});

export const ForecastInvoiceDTO = t.Object({
  card_id: t.String(),
  card_name: t.String(),
  dateStr: t.String(),
  amount: t.Number(),
  status: t.String()
});

// Definimos a resposta exata para o Nuxt receber com autocomplete
export const ForecastResponseDTO = t.Object({
  timeline: t.Array(
    t.Object({
      date: t.String(),
      balance: t.Number()
    })
  ),
  upcomingInvoices: t.Array(ForecastInvoiceDTO)
});

// ---- Recorrências ----
export const RecurrenceDTO = t.Object({
  name: t.String(),
  amount: t.Numeric({ minimum: 0.01 }),
  payday: t.Numeric({ minimum: 1, maximum: 31 }),
  type: t.Union([t.Literal('income'), t.Literal('expense')]),
  account_id: t.Optional(t.String()),
  card_id: t.Optional(t.String()),
  end_date: t.Optional(t.String()),
  total_installments: t.Optional(t.Number()),
});

// ---- Orçamentos / Categorias ----
export const CategoryDTO = t.Object({
  name: t.String(),
  type: t.Union([t.Literal('fixed_budget'), t.Literal('variable')]),
  monthly_budget: t.Optional(t.Numeric()),
});

// ---- Projetos / Freelas ----
export const ProjectCreateDTO = t.Object({
  name: t.String(),
  total_value: t.Numeric({ minimum: 0 }),
});

export const ProjectPaymentDTO = t.Object({
  amount: t.Numeric({ minimum: 0.01 }),
  description: t.Optional(t.String()),
});

// ---- Contas e Cartões ----
export const AccountDTO = t.Object({
  name: t.String(),
  type: t.Union([t.Literal('checking'), t.Literal('savings'), t.Literal('investment')]),
  initial_balance: t.Numeric(),
});

export const CardDTO = t.Object({
  name: t.String(),
  closing_day: t.Numeric({ minimum: 1, maximum: 31 }),
  due_day: t.Numeric({ minimum: 1, maximum: 31 }),
  limit: t.Numeric({ minimum: 0 }),
});

// ---- Faturas de Cartão (Virtuais) ----
export const InvoiceTransactionDTO = t.Object({
  id: t.String(),
  title: t.String(),
  amount: t.Number(),
  status: t.String(), // 'pending' | 'realized'
  expected_date: t.String()
});

export const InvoiceDTO = t.Object({
  period: t.String(), // Ex: '2026-05'
  dueDate: t.String(),
  totalAmount: t.Number(),
  totalSpent: t.Number(),
  status: t.Union([t.Literal('OPEN'), t.Literal('CLOSED'), t.Literal('PAID')]),
  transactions: t.Array(InvoiceTransactionDTO)
});

export const CardInvoicesResponseDTO = t.Array(InvoiceDTO);

export const PayInvoiceDTO = t.Object({
  period: t.String({ description: 'Formato YYYY-MM-DD (ou YYYY-MM legado)' }),
  account_id: t.Optional(t.String({ description: 'ID da conta de onde o dinheiro vai sair' })),
  amount_paid: t.Optional(t.Numeric({ description: 'Opcional para auditoria futura' })),
  ignore_balance: t.Optional(t.Boolean({ description: 'Se true, não desconta da conta, apenas dá baixa.' }))
});
