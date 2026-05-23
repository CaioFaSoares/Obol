import { Elysia } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { ProjectPaymentDTO, ProjectCreateDTO } from '../schemas/models';
import type PocketBase from 'pocketbase';

export const projectRoutes = new Elysia({ prefix: '/api/projects' })
  .use(pbPlugin)

  // GET /api/projects — Lista todos os projetos com 'received' e 'accounts_breakdown' calculados
  .get('/', async ({ pb }: { pb: PocketBase }) => {
    const projects = await pb.collection('projects').getFullList();
    
    const accounts = await pb.collection('accounts').getFullList();
    const accountMap = new Map(accounts.map((a: any) => [a.id, a.name]));

    const enriched = await Promise.all(
      projects.map(async (project) => {
        // Soma todas as receitas vinculadas ao projeto
        const payments = await pb.collection('transactions').getFullList({
          filter: `project_id = '${project.id}' && type = 'income'`
        });

        let received = 0;
        const breakdownMap = new Map<string, number>();

        for (const t of payments) {
          const amt = t.amount || 0;
          received += amt;
          
          if (t.account_id) {
            const accName = accountMap.get(t.account_id) || 'Conta Desconhecida';
            const curr = breakdownMap.get(accName) || 0;
            breakdownMap.set(accName, curr + amt);
          } else {
            const curr = breakdownMap.get('Outros/Dinheiro') || 0;
            breakdownMap.set('Outros/Dinheiro', curr + amt);
          }
        }

        const accounts_breakdown = Array.from(breakdownMap.entries()).map(([account_name, amount]) => ({
          account_name,
          amount
        }));

        return {
          id: project.id,
          name: project.name,
          total_value: project.total_value,
          status: project.status,
          received,
          accounts_breakdown
        };
      })
    );

    return enriched;
  })

  // POST /api/projects — Cria novo projeto
  .post('/', async ({ body, pb, set }: { body: any, pb: PocketBase, set: any }) => {
    try {
      const record = await pb.collection('projects').create({
        ...body,
        status: 'active'
      });
      set.status = 201;
      return record;
    } catch (err: any) {
      console.error('Falha ao criar projeto:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao criar projeto', details: err.data || err.message };
    }
  }, {
    body: ProjectCreateDTO
  })

  // POST /api/projects/:id/payment — Registra pagamento parcial
  .post('/:id/payment', async ({ params, body, pb, set }: { params: { id: string }, body: any, pb: PocketBase, set: any }) => {
    try {
      const project = await pb.collection('projects').getOne(params.id);
      if (!project) {
        set.status = 404;
        return { error: 'Projeto não encontrado' };
      }

      const now = new Date().toISOString();
      const transaction = await pb.collection('transactions').create({
        title: body.description || `Pagamento — ${project.name}`,
        amount: body.amount,
        type: 'income',
        status: 'realized',
        expected_date: now,
        realized_date: now,
        project_id: params.id,
      });

      set.status = 201;
      return transaction;
    } catch (err: any) {
      console.error('Falha ao registrar pagamento:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao registrar pagamento', details: err.data || err.message };
    }
  }, {
    body: ProjectPaymentDTO
  })

  // PATCH /api/projects/:id/complete — Finaliza projeto
  .patch('/:id/complete', async ({ params, pb, set }: { params: { id: string }, pb: PocketBase, set: any }) => {
    try {
      const record = await pb.collection('projects').update(params.id, {
        status: 'completed'
      });
      return record;
    } catch (err: any) {
      console.error('Falha ao finalizar projeto:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao finalizar projeto', details: err.data || err.message };
    }
  });
