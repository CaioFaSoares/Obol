import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { CardDTO, CardInvoicesResponseDTO, PayInvoiceDTO } from '../validators/cardSchemas';
import { ListCardsUseCase } from '../../application/use-cases/cards/ListCardsUseCase';
import { CreateCardUseCase } from '../../application/use-cases/cards/CreateCardUseCase';
import { UpdateCardUseCase } from '../../application/use-cases/cards/UpdateCardUseCase';
import { GetCardInvoicesUseCase } from '../../application/use-cases/cards/GetCardInvoicesUseCase';
import { PayInvoiceUseCase } from '../../application/use-cases/cards/PayInvoiceUseCase';
import { DeleteInvoiceUseCase } from '../../application/use-cases/cards/DeleteInvoiceUseCase';

export const cardController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/cards' })
    // GET /api/cards
    .get('/', async () => {
      const useCase = container.resolve<ListCardsUseCase>('listCardsUseCase');
      return await useCase.execute();
    })

    // POST /api/cards
    .post('/', async ({ body, set }) => {
      const useCase = container.resolve<CreateCardUseCase>('createCardUseCase');
      const card = await useCase.execute(body);
      set.status = 201;
      return card;
    }, {
      body: CardDTO
    })

    // PATCH /api/cards/:id
    .patch('/:id', async ({ params, body }) => {
      const useCase = container.resolve<UpdateCardUseCase>('updateCardUseCase');
      return await useCase.execute(params.id, body);
    })

    // GET /api/cards/:id/invoices
    .get('/:id/invoices', async ({ params }) => {
      const useCase = container.resolve<GetCardInvoicesUseCase>('getCardInvoicesUseCase');
      return await useCase.execute(params.id);
    }, {
      response: {
        200: CardInvoicesResponseDTO,
        500: t.Object({ error: t.String(), details: t.Optional(t.Any()) })
      }
    })

    // POST /api/cards/:id/pay-invoice
    .post('/:id/pay-invoice', async ({ params, body }) => {
      const useCase = container.resolve<PayInvoiceUseCase>('payInvoiceUseCase');
      return await useCase.execute({
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
      const useCase = container.resolve<DeleteInvoiceUseCase>('deleteInvoiceUseCase');
      return await useCase.execute(params.id, params.period);
    });
