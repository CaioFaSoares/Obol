import { Elysia } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { CategoryDTO } from '../schemas/models';
import type PocketBase from 'pocketbase';

export const categoryRoutes = new Elysia({ prefix: '/api/categories' })
  .use(pbPlugin)

  // GET /api/categories — Lista todas as categorias
  .get('/', async ({ pb }: { pb: PocketBase }) => {
    return await pb.collection('categories').getFullList({ sort: 'name' });
  })

  // GET /api/categories/budgets — Retorna fixed_budget com 'spent' calculado do mês
  .get('/budgets', async ({ pb }: { pb: PocketBase }) => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();

    const startOfMonth = new Date(Date.UTC(year, month, 1)).toISOString();
    const endOfMonth = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)).toISOString();

    // 1. Busca apenas categorias de orçamento fixo
    const categories = await pb.collection('categories').getFullList({
      filter: "type = 'fixed_budget'",
      sort: 'name'
    });

    // 2. Para cada categoria, soma as despesas realizadas ou pendentes do mês
    const enriched = await Promise.all(
      categories.map(async (cat) => {
        const transactions = await pb.collection('transactions').getFullList({
          filter: `category_id = '${cat.id}' && type = 'expense' && expected_date >= '${startOfMonth}' && expected_date <= '${endOfMonth}'`
        });

        const spent = transactions.reduce((sum, t) => sum + (t.amount || 0), 0);

        return {
          id: cat.id,
          name: cat.name,
          monthly_budget: cat.monthly_budget || 0,
          spent,
        };
      })
    );

    return enriched;
  })

  // POST /api/categories — Cria nova categoria
  .post('/', async ({ body, pb, set }: { body: any, pb: PocketBase, set: any }) => {
    try {
      const record = await pb.collection('categories').create(body);
      set.status = 201;
      return record;
    } catch (err: any) {
      console.error('Falha ao criar categoria:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao criar categoria', details: err.data || err.message };
    }
  }, {
    body: CategoryDTO
  });

