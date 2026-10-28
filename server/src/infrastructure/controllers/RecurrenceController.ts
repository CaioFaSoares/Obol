import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { RecurrenceDTO } from '../validators/recurrenceSchemas';
import { executeUseCase } from '../use-case-routes';

export const recurrenceController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/recurrences' })
    // GET /api/recurrences
    .get('/', async () => {
      return await executeUseCase(container, 'listRecurrencesUseCase');
    })

    // POST /api/recurrences
    .post('/', async ({ body, set }) => {
      const record = await executeUseCase(container, 'createRecurrenceUseCase', body);
      set.status = 201;
      return record;
    }, {
      body: RecurrenceDTO
    })

    // PUT /api/recurrences/:id
    .put('/:id', async ({ params, body }) => {
      return await executeUseCase(container, 'updateRecurrenceUseCase', params.id, body);
    }, {
      body: t.Partial(RecurrenceDTO)
    })

    // DELETE /api/recurrences/:id
    .delete('/:id', async ({ params }) => {
      return await executeUseCase(container, 'deleteRecurrenceUseCase', params.id);
    })

    // GET /api/recurrences/:id/transactions
    .get('/:id/transactions', async ({ params }) => {
      return await executeUseCase(container, 'getRecurrenceTransactionsUseCase', params.id);
    })

    // PATCH /api/recurrences/:id/toggle-status
    .patch('/:id/toggle-status', async ({ params, body }) => {
      return await executeUseCase(container, 'toggleRecurrenceStatusUseCase', params.id, body.status);
    }, {
      body: t.Object({
        status: t.Union([t.Literal('active'), t.Literal('paused')])
      })
    })

    // POST /api/recurrences/:id/launch
    .post('/:id/launch', async ({ params, set }) => {
      const transaction = await executeUseCase(container, 'launchRecurrenceUseCase', params.id);
      set.status = 201;
      return transaction;
    });
