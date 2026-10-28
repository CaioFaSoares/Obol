import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { asValue, createContainer, InjectionMode } from 'awilix';
import type { AwilixContainer } from 'awilix';
import { errorPlugin } from '../src/infrastructure/plugins/errorPlugin';
import { accountController } from '../src/infrastructure/controllers/AccountController';
import { categoryController } from '../src/infrastructure/controllers/CategoryController';
import { transactionController } from '../src/infrastructure/controllers/TransactionController';
import { cardController } from '../src/infrastructure/controllers/CardController';
import { NotFoundError, ValidationError } from '../src/domain/errors';

// Deterministic double: records every `execute` call without touching
// repositories or PocketBase.
function recordingUseCase<T>(result: T) {
  const calls: unknown[][] = [];
  return {
    calls,
    execute: async (...args: unknown[]): Promise<T> => {
      calls.push(args);
      return result;
    },
  };
}

// Same double but rejects instead of resolving, to exercise domain error bubbling.
function rejectingUseCase(error: Error) {
  let executeCalls = 0;
  return {
    get executeCalls() {
      return executeCalls;
    },
    execute: async (): Promise<never> => {
      executeCalls += 1;
      throw error;
    },
  };
}

function bootApp(container: AwilixContainer) {
  return new Elysia()
    .use(errorPlugin)
    .use(accountController(container))
    .use(categoryController(container))
    .use(transactionController(container))
    .use(cardController(container));
}

const jsonRequest = (path: string, method: string, body?: unknown) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe('HTTP use-case dispatch boundary', () => {
  test('valid list request dispatches exactly once with parsed inputs', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const listResult = {
      items: [],
      page: 2,
      perPage: 5,
      totalItems: 0,
      totalPages: 0,
    };
    const listFake = recordingUseCase(listResult);
    container.register({ listTransactionsUseCase: asValue(listFake) });
    const app = bootApp(container);

    const response = await app.handle(
      jsonRequest(
        '/api/transactions?page=2&perPage=5&sort=amount&filter=type%3Dexpense',
        'GET'
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(listResult);
    // Inputs are the controller-mapped values (strings, numbers), not raw query.
    expect(listFake.calls).toEqual([
      [{ page: 2, perPage: 5, sort: 'amount', filter: 'type=expense' }],
    ]);
  });

  test('list request applies default page/sort when query is absent', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const listFake = recordingUseCase({
      items: [],
      page: 1,
      perPage: 15,
      totalItems: 0,
      totalPages: 0,
    });
    container.register({ listTransactionsUseCase: asValue(listFake) });
    const app = bootApp(container);

    const response = await app.handle(jsonRequest('/api/transactions', 'GET'));

    expect(response.status).toBe(200);
    expect(listFake.calls).toEqual([
      [{ page: 1, perPage: 15, sort: '-expected_date', filter: undefined }],
    ]);
  });

  test('invalid body is rejected with 400 and the use case never executes', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const createFake = recordingUseCase({ id: 'cat_1' });
    container.register({ createCategoryUseCase: asValue(createFake) });
    const app = bootApp(container);

    // Missing required `type` field.
    const response = await app.handle(
      jsonRequest('/api/categories', 'POST', { name: 'Groceries' })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('Bad Request');
    expect(createFake.calls.length).toBe(0);
  });

  test('domain NotFoundError maps to the existing 404 response', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const listFake = rejectingUseCase(new NotFoundError('Category not found'));
    container.register({ listCategoriesUseCase: asValue(listFake) });
    const app = bootApp(container);

    const response = await app.handle(jsonRequest('/api/categories', 'GET'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Not Found',
      details: 'Category not found',
    });
    expect(listFake.executeCalls).toBe(1);
  });

  test('domain ValidationError maps to the existing 400 response', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const listFake = rejectingUseCase(new ValidationError('No accounts registered'));
    container.register({ listAccountsUseCase: asValue(listFake) });
    const app = bootApp(container);

    const response = await app.handle(jsonRequest('/api/accounts', 'GET'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Validation Error',
      details: 'No accounts registered',
    });
    expect(listFake.executeCalls).toBe(1);
  });

  test('create endpoint keeps 201 status and returns the use case result unchanged', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const account = { id: 'acc_1', name: 'Wallet', type: 'checking', initial_balance: 100 };
    const createFake = recordingUseCase(account);
    container.register({ createAccountUseCase: asValue(createFake) });
    const app = bootApp(container);

    const response = await app.handle(
      jsonRequest('/api/accounts', 'POST', {
        name: 'Wallet',
        type: 'checking',
        initial_balance: '100.00',
      })
    );

    // Created response status.
    expect(response.status).toBe(201);
    // Response body is exactly what the use case returned.
    expect(await response.json()).toEqual(account);
    // Dispatched once with the TypeBox-parsed body (numeric coercion included).
    expect(createFake.calls).toEqual([
      [{ name: 'Wallet', type: 'checking', initial_balance: 100 }],
    ]);
  });

  test('custom input mapping keeps JSON fields aligned to use-case arguments', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const payFake = recordingUseCase({ success: true });
    container.register({ payInvoiceUseCase: asValue(payFake) });
    const app = bootApp(container);

    const response = await app.handle(
      jsonRequest('/api/cards/card_1/pay-invoice', 'POST', {
        period: '2026-05',
        account_id: 'acc_9',
        amount_paid: '250.50',
        ignore_balance: true,
      })
    );

    expect(response.status).toBe(200);
    expect(payFake.calls).toEqual([
      [
        {
          cardId: 'card_1',
          period: '2026-05',
          accountId: 'acc_9',
          amountPaid: 250.5,
          ignoreBalance: true,
        },
      ],
    ]);
  });

  test('dispatch invokes the resolved class method with its instance receiver', async () => {
    const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
    const listFake = {
      calls: 0,
      result: [{ id: 'cat_1', name: 'Food' }],
      async execute() {
        this.calls += 1;
        return this.result;
      }
    };
    container.register({ listCategoriesUseCase: asValue(listFake) });
    const app = bootApp(container);

    const response = await app.handle(jsonRequest('/api/categories', 'GET'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(listFake.result);
    expect(listFake.calls).toBe(1);
  });
});
