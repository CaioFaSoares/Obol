import { Elysia } from 'elysia';
import { AwilixContainer } from 'awilix';
import { AccountDTO } from '../validators/accountSchemas';
import { ListAccountsUseCase } from '../../application/use-cases/accounts/ListAccountsUseCase';
import { CreateAccountUseCase } from '../../application/use-cases/accounts/CreateAccountUseCase';

export const accountController = (container: AwilixContainer) =>
  new Elysia({ prefix: '/api/accounts' })
    // GET /api/accounts
    .get('/', async () => {
      const useCase = container.resolve<ListAccountsUseCase>('listAccountsUseCase');
      return await useCase.execute();
    })

    // POST /api/accounts
    .post('/', async ({ body, set }) => {
      const useCase = container.resolve<CreateAccountUseCase>('createAccountUseCase');
      const account = await useCase.execute(body);
      set.status = 201;
      return account;
    }, {
      body: AccountDTO
    });
