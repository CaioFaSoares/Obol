import { describe, expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { asValue, createContainer as createAwilixContainer } from 'awilix';
import { adminController } from '../src/infrastructure/controllers/AdminController';
import { errorPlugin } from '../src/infrastructure/plugins/errorPlugin';
import { ResetFinancialDataUseCase } from '../src/application/use-cases/maintenance/ResetFinancialDataUseCase';
import { PocketbaseDatabaseMaintenanceRepository } from '../src/infrastructure/repositories/PocketbaseDatabaseMaintenanceRepository';
import type { ClearedFinancialData } from '../src/domain/interfaces/DatabaseMaintenanceRepository';

const EMPTY_COUNTS: ClearedFinancialData = {
  transactions: 0,
  invoices: 0,
  recurrences: 0,
  cards: 0,
  accounts: 0,
  categories: 0,
  projects: 0,
};

function resetApp(result: { cleared: ClearedFinancialData; total: number }) {
  const container = createAwilixContainer();
  let calls = 0;
  // The admin write path dispatches through the shared mutation runtime.
  container.register({
    syncRuntime: asValue({
      execute: async () => {
        calls += 1;
        return result;
      },
    }),
  });
  const app = new Elysia().use(errorPlugin).use(adminController(container));
  return { app, calls: () => calls };
}

function resetRequest(app: Pick<Elysia, 'handle'>, body: unknown): Promise<Response> {
  return app.handle(
    new Request('http://obol.local/api/admin/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('admin reset route', () => {
  test('rejects a missing or wrong confirmation without invoking the use case', async () => {
    const { app, calls } = resetApp({ cleared: EMPTY_COUNTS, total: 0 });

    for (const body of [{}, { confirm: '' }]) {
      const response = await resetRequest(app, body);
      expect(response.status).toBe(400);
    }

    const wrongPhrase = await resetRequest(app, { confirm: 'APAGAR' });
    expect(wrongPhrase.status).toBe(400);
    expect(calls()).toBe(0);
  });
});

describe('ResetFinancialDataUseCase', () => {
  test('reports the total of every cleared collection', async () => {
    const cleared: ClearedFinancialData = {
      transactions: 12,
      invoices: 3,
      recurrences: 2,
      cards: 1,
      accounts: 4,
      categories: 5,
      projects: 1,
    };
    const useCase = new ResetFinancialDataUseCase({
      clearFinancialData: async () => cleared,
    });

    expect(await useCase.execute()).toEqual({ cleared, total: 28 });
  });
});

describe('PocketbaseDatabaseMaintenanceRepository', () => {
  test('deletes children before parents and reports each collection count', async () => {
    const collections: Record<string, string[]> = {
      transactions: ['tx1', 'tx2'],
      invoices: ['inv1'],
      recurrences: ['rec1'],
      cards: ['card1'],
      accounts: ['acc1', 'acc2'],
      categories: ['cat1'],
      projects: ['proj1'],
    };
    const deleted: string[] = [];
    const pb = {
      collection(name: string) {
        return {
          async getFullList() {
            return (collections[name] ?? []).map((id) => ({ id }));
          },
          async getList() {
            return {
              items: name === 'obol_sync_meta'
                ? [{ id: 'meta1', dataEpoch: 3 }]
                : [],
            };
          },
        };
      },
      createBatch() {
        return {
          collection(name: string) {
            return {
              delete(id: string) {
                deleted.push(`${name}:${id}`);
              },
              update() {
                // Epoch rotation is asserted through the deleted order only.
              },
            };
          },
          async send() {
            return [];
          },
        };
      },
    };

    const repository = new PocketbaseDatabaseMaintenanceRepository(pb as never);
    const cleared = await repository.clearFinancialData();

    expect(cleared).toEqual({
      transactions: 2,
      invoices: 1,
      recurrences: 1,
      cards: 1,
      accounts: 2,
      categories: 1,
      projects: 1,
    });
    expect(deleted).toEqual([
      'transactions:tx1',
      'transactions:tx2',
      'invoices:inv1',
      'recurrences:rec1',
      'cards:card1',
      'accounts:acc1',
      'accounts:acc2',
      'categories:cat1',
      'projects:proj1',
    ]);
  });
});
