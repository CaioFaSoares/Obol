import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { TransactionDTO } from '../validators/transactionSchemas';
import { executeUseCase } from '../use-case-routes';

export const transactionController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/transactions' })
    // POST /api/transactions
    .post('/', async ({ body, set }) => {
      const transaction = await executeUseCase(container, 'createTransactionUseCase', body);
      set.status = 201;
      return transaction;
    }, {
      body: TransactionDTO
    })

    // GET /api/transactions
    .get('/', async ({ query }) => {
      const page = Number(query?.page) || 1;
      const perPage = Number(query?.perPage) || 15;
      const sort = query?.sort || '-expected_date';
      const filter = query?.filter;

      return await executeUseCase(container, 'listTransactionsUseCase', { page, perPage, sort, filter });
    }, {
      query: t.Optional(t.Object({
        filter: t.Optional(t.String()),
        sort: t.Optional(t.String()),
        page: t.Optional(t.String()),
        perPage: t.Optional(t.String())
      }))
    })

    // DELETE /api/transactions/:id
    .delete('/:id', async ({ params }) => {
      return await executeUseCase(container, 'deleteTransactionUseCase', params.id);
    })

    // PATCH /api/transactions/:id
    .patch('/:id', async ({ params, body }) => {
      return await executeUseCase(container, 'updateTransactionUseCase', params.id, body);
    }, {
      body: t.Partial(TransactionDTO)
    })

    // PATCH /api/transactions/:id/realize
    .patch('/:id/realize', async ({ params, body }) => {
      return await executeUseCase(container, 'realizeTransactionUseCase', params.id, body);
    }, {
      body: t.Object({
        update_balance: t.Optional(t.Boolean({ default: true }))
      })
    });
