import { t } from 'elysia';

export const CardDTO = t.Object({
  name: t.String(),
  closing_day: t.Numeric({ minimum: 1, maximum: 31 }),
  due_day: t.Numeric({ minimum: 1, maximum: 31 }),
  limit: t.Numeric({ minimum: 0 }),
});

export const InvoiceTransactionDTO = t.Object({
  id: t.String(),
  title: t.String(),
  amount: t.Number(),
  status: t.String(), // 'pending' | 'realized' | 'projected'
  expected_date: t.String(),
  purchase_date: t.Optional(t.Nullable(t.String())),
  recurrence_id: t.Optional(t.Nullable(t.String()))
});

export const InvoiceDTO = t.Object({
  period: t.String(), // Ex: '2026-05'
  dueDate: t.String(),
  totalAmount: t.Number(),
  paidAmount: t.Number(),
  totalSpent: t.Number(),
  status: t.Union([t.Literal('OPEN'), t.Literal('CLOSED'), t.Literal('PAID'), t.Literal('PROJECTED')]),
  transactions: t.Array(InvoiceTransactionDTO)
});

export const CardInvoicesResponseDTO = t.Array(InvoiceDTO);

export const PayInvoiceDTO = t.Object({
  period: t.String({ description: 'Formato YYYY-MM-DD (ou YYYY-MM legado)' }),
  account_id: t.Optional(t.String({ description: 'ID da conta de onde o dinheiro vai sair' })),
  amount_paid: t.Optional(t.Numeric({ description: 'Opcional para auditoria futura' })),
  ignore_balance: t.Optional(t.Boolean({ description: 'Se true, não desconta da conta, apenas dá baixa.' }))
});
