import { Elysia, t } from 'elysia';
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

  // PUT /api/recurrences/:id — Edita recorrência
  .put('/:id', async ({ params, body, pb, set }: { params: { id: string }, body: any, pb: PocketBase, set: any }) => {
    try {
      const updated = await pb.collection('recurrences').update(params.id, body);
      return updated;
    } catch (err: any) {
      console.error('Falha ao editar recorrência:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao editar recorrência', details: err.data || err.message };
    }
  }, {
    body: t.Partial(RecurrenceDTO) // Usa a versão parcial do DTO (já que pode atualizar só alguns campos)
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
  })

  // GET /api/recurrences/:id/transactions — Traz histórico da assinatura
  .get('/:id/transactions', async ({ params, pb, set }: { params: { id: string }, pb: PocketBase, set: any }) => {
    try {
      const txns = await pb.collection('transactions').getFullList({
        filter: `recurrence_id = '${params.id}'`,
        sort: '-expected_date'
      });
      return txns;
    } catch (err: any) {
      console.error('Falha ao listar transações da recorrência:', err.data || err.message || err);
      set.status = err.status || 500;
      return { error: 'Falha ao listar transações', details: err.data || err.message };
    }
  })

  // PATCH /api/recurrences/:id/toggle-status — Pausar / Reativar
  .patch('/:id/toggle-status', async ({ params, body, pb, set }: { params: { id: string }, body: any, pb: PocketBase, set: any }) => {
    try {
      const updated = await pb.collection('recurrences').update(params.id, {
        status: body.status
      });
      return updated;
    } catch (err: any) {
      console.error('Falha ao alternar status:', err.data || err.message || err);
      set.status = err.status || 500;
      return { error: 'Falha ao alternar status', details: err.data || err.message };
    }
  }, {
    body: t.Object({
      status: t.Union([t.Literal('active'), t.Literal('paused')])
    })
  })

  // POST /api/recurrences/:id/launch — Lançamento manual
  .post('/:id/launch', async ({ params, pb, set }: { params: { id: string }, pb: PocketBase, set: any }) => {
    try {
      const recurrence = await pb.collection('recurrences').getOne(params.id);
      
      const now = new Date();
      // Configurar expected_date para o dia de vencimento (payday) no mês atual
      let expectedDate = new Date(now.getFullYear(), now.getMonth(), recurrence.payday);
      
      const newTxn = await pb.collection('transactions').create({
        title: `${recurrence.name} - Lançamento Manual`,
        amount: recurrence.amount,
        type: recurrence.type,
        status: 'pending',
        expected_date: expectedDate.toISOString(),
        is_recurring: true,
        account_id: recurrence.account_id || null,
        card_id: recurrence.card_id || null,
        recurrence_id: recurrence.id
      });
      
      set.status = 201;
      return newTxn;
    } catch (err: any) {
      console.error('Falha ao lançar recorrência manual:', err.data || err.message || err);
      set.status = err.status || 500;
      return { error: 'Falha ao lançar recorrência manual', details: err.data || err.message };
    }
  });
