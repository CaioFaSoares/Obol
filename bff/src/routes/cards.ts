import { Elysia } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { CardDTO } from '../schemas/models';
import type PocketBase from 'pocketbase';

export const cardRoutes = new Elysia({ prefix: '/api/cards' })
  .use(pbPlugin)

  // GET /api/cards — Lista todos os cartões
  .get('/', async ({ pb }: { pb: PocketBase }) => {
    return await pb.collection('cards').getFullList({ sort: 'name' });
  })

  // POST /api/cards — Cria novo cartão
  .post('/', async ({ body, pb, set }: { body: any, pb: PocketBase, set: any }) => {
    try {
      const record = await pb.collection('cards').create(body);
      set.status = 201;
      return record;
    } catch (err: any) {
      console.error('Falha ao criar cartão:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao criar cartão', details: err.data || err.message };
    }
  }, {
    body: CardDTO
  });
