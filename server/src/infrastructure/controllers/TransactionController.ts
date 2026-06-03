import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { TransactionDTO } from '../validators/transactionSchemas';
import { CreateTransactionUseCase } from '../../application/use-cases/transactions/CreateTransactionUseCase';
import { ListTransactionsUseCase } from '../../application/use-cases/transactions/ListTransactionsUseCase';
import { DeleteTransactionUseCase } from '../../application/use-cases/transactions/DeleteTransactionUseCase';
import { UpdateTransactionUseCase } from '../../application/use-cases/transactions/UpdateTransactionUseCase';
import { RealizeTransactionUseCase } from '../../application/use-cases/transactions/RealizeTransactionUseCase';

export const transactionController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/transactions' })
    // POST /api/transactions
    .post('/', async ({ body, set }) => {
      const useCase = container.resolve<CreateTransactionUseCase>('createTransactionUseCase');
      const transaction = await useCase.execute(body);
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

      const useCase = container.resolve<ListTransactionsUseCase>('listTransactionsUseCase');
      return await useCase.execute({ page, perPage, sort, filter });
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
      const useCase = container.resolve<DeleteTransactionUseCase>('deleteTransactionUseCase');
      return await useCase.execute(params.id);
    })

    // PATCH /api/transactions/:id
    .patch('/:id', async ({ params, body }) => {
      const useCase = container.resolve<UpdateTransactionUseCase>('updateTransactionUseCase');
      return await useCase.execute(params.id, body);
    }, {
      body: t.Partial(TransactionDTO)
    })

    // PATCH /api/transactions/:id/realize
    .patch('/:id/realize', async ({ params, body }) => {
      const useCase = container.resolve<RealizeTransactionUseCase>('realizeTransactionUseCase');
      return await useCase.execute(params.id, body);
    }, {
      body: t.Object({
        update_balance: t.Optional(t.Boolean({ default: true }))
      })
    });
