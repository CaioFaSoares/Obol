import { Elysia, t } from 'elysia';
import { AwilixContainer } from 'awilix';
import { RecurrenceDTO } from '../validators/recurrenceSchemas';
import { ListRecurrencesUseCase } from '../../application/use-cases/recurrences/ListRecurrencesUseCase';
import { CreateRecurrenceUseCase } from '../../application/use-cases/recurrences/CreateRecurrenceUseCase';
import { UpdateRecurrenceUseCase } from '../../application/use-cases/recurrences/UpdateRecurrenceUseCase';
import { DeleteRecurrenceUseCase } from '../../application/use-cases/recurrences/DeleteRecurrenceUseCase';
import { ToggleRecurrenceStatusUseCase } from '../../application/use-cases/recurrences/ToggleRecurrenceStatusUseCase';
import { LaunchRecurrenceUseCase } from '../../application/use-cases/recurrences/LaunchRecurrenceUseCase';
import { GetRecurrenceTransactionsUseCase } from '../../application/use-cases/recurrences/GetRecurrenceTransactionsUseCase';

export const recurrenceController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/recurrences' })
    // GET /api/recurrences
    .get('/', async () => {
      const useCase = container.resolve<ListRecurrencesUseCase>('listRecurrencesUseCase');
      return await useCase.execute();
    })

    // POST /api/recurrences
    .post('/', async ({ body, set }) => {
      const useCase = container.resolve<CreateRecurrenceUseCase>('createRecurrenceUseCase');
      const record = await useCase.execute(body);
      set.status = 201;
      return record;
    }, {
      body: RecurrenceDTO
    })

    // PUT /api/recurrences/:id
    .put('/:id', async ({ params, body }) => {
      const useCase = container.resolve<UpdateRecurrenceUseCase>('updateRecurrenceUseCase');
      return await useCase.execute(params.id, body);
    }, {
      body: t.Partial(RecurrenceDTO)
    })

    // DELETE /api/recurrences/:id
    .delete('/:id', async ({ params }) => {
      const useCase = container.resolve<DeleteRecurrenceUseCase>('deleteRecurrenceUseCase');
      return await useCase.execute(params.id);
    })

    // GET /api/recurrences/:id/transactions
    .get('/:id/transactions', async ({ params }) => {
      const useCase = container.resolve<GetRecurrenceTransactionsUseCase>('getRecurrenceTransactionsUseCase');
      return await useCase.execute(params.id);
    })

    // PATCH /api/recurrences/:id/toggle-status
    .patch('/:id/toggle-status', async ({ params, body }) => {
      const useCase = container.resolve<ToggleRecurrenceStatusUseCase>('toggleRecurrenceStatusUseCase');
      return await useCase.execute(params.id, body.status);
    }, {
      body: t.Object({
        status: t.Union([t.Literal('active'), t.Literal('paused')])
      })
    })

    // POST /api/recurrences/:id/launch
    .post('/:id/launch', async ({ params, set }) => {
      const useCase = container.resolve<LaunchRecurrenceUseCase>('launchRecurrenceUseCase');
      const transaction = await useCase.execute(params.id);
      set.status = 201;
      return transaction;
    });
