import { Elysia } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { RecurrenceDTO } from '../schemas/models';
import type PocketBase from 'pocketbase';

export const recurrenceRoutes = new Elysia({ prefix: '/api/recurrences' })
  .use(pbPlugin)

  // GET /api/recurrences — Lista todas as recorrências (ativas e encerradas)
  .get('/', async ({ pb, set }: { pb: PocketBase, set: any }) => {
    try {
      const recurrences = await pb.collection('recurrences').getFullList();
      return recurrences;
    } catch (err: any) {
      console.error('Falha ao listar recorrências:', err.data || err.message || err);
      set.status = err.status || 500;
      return { error: 'Falha ao listar recorrências', details: err.data || err.message };
    }
  })

  // POST /api/recurrences — Cria nova recorrência
  .post('/', async ({ body, pb, set }: { body: any, pb: PocketBase, set: any }) => {
    try {
      const record = await pb.collection('recurrences').create({
        ...body,
        status: 'active',
      });
      set.status = 201;
      return record;
    } catch (err: any) {
      console.error('Falha ao criar recorrência:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao criar recorrência', details: err.data || err.message };
    }
  }, {
    body: RecurrenceDTO
  })

  // DELETE /api/recurrences/:id — Soft delete: muda status para 'ended'
  .delete('/:id', async ({ params, pb, set }: { params: { id: string }, pb: PocketBase, set: any }) => {
    try {
      await pb.collection('recurrences').update(params.id, { status: 'ended' });
      return { success: true };
    } catch (err: any) {
      console.error('Falha ao desativar recorrência:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao desativar recorrência', details: err.data || err.message };
    }
  });
