import { t } from 'elysia';

export const TransactionQueryFiltersDTO = t.Object({
  search: t.Optional(t.String({ maxLength: 200 })),
  status: t.Optional(t.Union([
    t.Literal('all'),
    t.Literal('pending'),
    t.Literal('realized')
  ])),
  type: t.Optional(t.Union([
    t.Literal('all'),
    t.Literal('income'),
    t.Literal('expense'),
    t.Literal('transfer')
  ])),
  simulation: t.Optional(t.Union([
    t.Literal('all'),
    t.Literal('real'),
    t.Literal('simulated')
  ])),
  scheduled: t.Optional(t.Union([
    t.Literal('all'),
    t.Literal('scheduled'),
    t.Literal('unscheduled')
  ])),
  accountId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  cardId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  categoryId: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  dateFrom: t.Optional(t.String({ format: 'date' })),
  dateTo: t.Optional(t.String({ format: 'date' })),
  dateField: t.Optional(t.Union([
    t.Literal('expected_date'),
    t.Literal('realized_date')
  ])),
}, { additionalProperties: false });

export const TransactionListQueryDTO = t.Object({
  ...TransactionQueryFiltersDTO.properties,
  page: t.Optional(t.String({ pattern: '^[1-9][0-9]*$' })),
  perPage: t.Optional(t.String({ pattern: '^[1-9][0-9]*$' })),
  sort: t.Optional(t.String({ maxLength: 40 })),
  expandInvoice: t.Optional(t.Literal('true')),
}, { additionalProperties: false });
