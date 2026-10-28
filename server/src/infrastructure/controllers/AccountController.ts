import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { AccountDTO } from '../validators/accountSchemas';
import { executeUseCase } from '../use-case-routes';

export const accountController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/accounts' })
    // GET /api/accounts
    .get('/', async () => {
      return await executeUseCase(container, 'listAccountsUseCase');
    })

    // POST /api/accounts
    .post('/', async ({ body, set }) => {
      const account = await executeUseCase(container, 'createAccountUseCase', body);
      set.status = 201;
      return account;
    }, {
      body: AccountDTO
    });
