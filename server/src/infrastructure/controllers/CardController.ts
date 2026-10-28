import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { CardDTO, CardInvoicesResponseDTO, PayInvoiceDTO } from '../validators/cardSchemas';
import { executeUseCase } from '../use-case-routes';
import type { Card } from '../../domain/entities/Card';

export const cardController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/cards' })
    // GET /api/cards
    .get('/', async () => {
      return await executeUseCase(container, 'listCardsUseCase');
    })

    // POST /api/cards
    .post('/', async ({ body, set }) => {
      const card = await executeUseCase(container, 'createCardUseCase', body);
      set.status = 201;
      return card;
    }, {
      body: CardDTO
    })

    // PATCH /api/cards/:id
    .patch('/:id', async ({ params, body }) => {
      return await executeUseCase(container, 'updateCardUseCase', params.id, body as Partial<Card>);
    })

    // GET /api/cards/:id/invoices
    .get('/:id/invoices', async ({ params }) => {
      return await executeUseCase(container, 'getCardInvoicesUseCase', params.id);
    }, {
      response: {
        200: CardInvoicesResponseDTO,
        500: t.Object({ error: t.String(), details: t.Optional(t.Any()) })
      }
    })

    // POST /api/cards/:id/pay-invoice
    .post('/:id/pay-invoice', async ({ params, body }) => {
      return await executeUseCase(container, 'payInvoiceUseCase', {
        cardId: params.id,
        period: body.period,
        accountId: body.account_id,
        amountPaid: body.amount_paid,
        ignoreBalance: body.ignore_balance
      });
    }, {
      body: PayInvoiceDTO
    })

    // DELETE /api/cards/:id/invoices/:period
    .delete('/:id/invoices/:period', async ({ params }) => {
      return await executeUseCase(container, 'deleteInvoiceUseCase', params.id, params.period);
    });
