import { Elysia } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { AccountDTO } from '../schemas/models';
import type PocketBase from 'pocketbase';

export const accountRoutes = new Elysia({ prefix: '/api/accounts' })
  .use(pbPlugin)

  // GET /api/accounts — Lista todas as contas
  .get('/', async ({ pb }: { pb: PocketBase }) => {
    return await pb.collection('accounts').getFullList({ sort: 'name' });
  })

  // POST /api/accounts — Cria nova conta
  .post('/', async ({ body, pb, set }: { body: any, pb: PocketBase, set: any }) => {
    try {
      const record = await pb.collection('accounts').create(body);
      set.status = 201;
      return record;
    } catch (err: any) {
      console.error('Falha ao criar conta:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao criar conta', details: err.data || err.message };
    }
  }, {
    body: AccountDTO
  });
