import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { ValidationError } from '../../domain/errors';
import { TransactionDTO } from '../validators/transactionSchemas';
import { executeUseCase } from '../use-case-routes';
import { TransactionListQueryDTO, TransactionQueryFiltersDTO } from '../validators/transactionQuerySchemas';

const FILTER_QUERY_KEYS = Object.keys(TransactionQueryFiltersDTO.properties);
const LIST_QUERY_KEYS = Object.keys(TransactionListQueryDTO.properties);

const assertKnownQueryKeys = (request: Request, allowed: readonly string[]) => {
  const unknownKey = [...new URL(request.url).searchParams.keys()]
    .find(key => !allowed.includes(key));
  if (unknownKey) {
    throw new ValidationError(`Unsupported transaction query parameter: ${unknownKey}`);
  }
};

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
    .get('/summary', async ({ query, request }) => {
      assertKnownQueryKeys(request, FILTER_QUERY_KEYS);
      return await executeUseCase(container, 'summarizeTransactionsUseCase', query);
    }, {
      query: TransactionQueryFiltersDTO
    })

    .get('/', async ({ query, request }) => {
      assertKnownQueryKeys(request, LIST_QUERY_KEYS);
      const { expandInvoice, ...filters } = query;

      return await executeUseCase(container, 'listTransactionsUseCase', {
        ...filters,
        page: Number(query.page) || 1,
        perPage: Number(query.perPage) || 15,
        sort: query.sort || '-expected_date',
        ...(expandInvoice === 'true' ? { expandInvoice: true } : {})
      });
    }, {
      query: TransactionListQueryDTO
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
