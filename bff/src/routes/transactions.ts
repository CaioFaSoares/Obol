import { Elysia } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { TransactionDTO } from '../schemas/models';
import { calculateCardDueDate } from '../utils/dateUtils';
import type PocketBase from 'pocketbase';

export const transactionRoutes = new Elysia({ prefix: '/api/transactions' })
  .use(pbPlugin)
  .post('/', async ({ body, pb, set }: { body: any, pb: PocketBase, set: any }) => {
    try {
      const data = { ...body };

      // ---------------------------------------------------------
      // REGRA 1: CONTA BANCÁRIA (Pix/Débito) + REALIZADO
      // ---------------------------------------------------------
      if (data.account_id && data.status === 'realized') {
        // 1. Busca a conta atual
        const account = await pb.collection('accounts').getOne(data.account_id);
        
        // 2. Calcula o novo saldo
        let newBalance = account.initial_balance;
        if (data.type === 'income') newBalance += data.amount;
        if (data.type === 'expense') newBalance -= data.amount;
        
        // 3. Atualiza o saldo no banco
        await pb.collection('accounts').update(data.account_id, { 
          initial_balance: newBalance 
        });

        // Garante que a data realizada está preenchida
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }

      // ---------------------------------------------------------
      // REGRA 2: CARTÃO DE CRÉDITO (Motor de Fatura)
      // ---------------------------------------------------------
      if (data.card_id && data.type === 'expense') {
        // 1. Busca as regras do cartão
        const card = await pb.collection('cards').getOne(data.card_id);
        
        // 2. Calcula para qual mês vai a fatura
        const projectedDueDate = calculateCardDueDate(
          data.expected_date, 
          card.closing_day, 
          card.due_day
        );

        // 3. Sobrescreve os dados para forçar o provisionamento futuro
        data.expected_date = projectedDueDate;
        data.status = 'pending'; // Gastos de cartão SEMPRE nascem pendentes
      }

      // Salva a transação final (seja da Regra 1 ou 2, ou outras puras)
      const transaction = await pb.collection('transactions').create(data);
      
      set.status = 201;
      return transaction;

    } catch (err: any) {
      console.error('Falha ao registrar transação:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao registrar transação', details: err.data || err.message };
    }
  }, { 
    body: TransactionDTO // Validação estrita TypeBox de entrada
  })

  // GET /api/transactions — Lista as transações ordenadas por data
  .get('/', async ({ pb }: { pb: PocketBase }) => {
    try {
      const records = await pb.collection('transactions').getList(1, 100, {
        sort: '-expected_date'
      });
      return records.items;
    } catch (err: any) {
      console.error('Falha ao listar transações:', err.data || err.message || err);
      return [];
    }
  })

  // DELETE /api/transactions/:id — Deleta e estorna saldo se necessário
  .delete('/:id', async ({ params, pb, set }: { params: { id: string }, pb: PocketBase, set: any }) => {
    try {
      const oldTxn = await pb.collection('transactions').getOne(params.id);

      if (oldTxn.account_id && oldTxn.status === 'realized') {
        const account = await pb.collection('accounts').getOne(oldTxn.account_id);
        let revertedBalance = account.initial_balance;
        
        if (oldTxn.type === 'income') revertedBalance -= oldTxn.amount;
        if (oldTxn.type === 'expense') revertedBalance += oldTxn.amount;

        await pb.collection('accounts').update(oldTxn.account_id, { 
          initial_balance: revertedBalance 
        });
      }

      await pb.collection('transactions').delete(params.id);
      return { success: true };
    } catch (err: any) {
      console.error('Falha ao excluir transação:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao excluir transação', details: err.data || err.message };
    }
  })

  // PATCH /api/transactions/:id — Edita e recalcula saldos
  .patch('/:id', async ({ params, body, pb, set }: { params: { id: string }, body: any, pb: PocketBase, set: any }) => {
    try {
      const oldTxn = await pb.collection('transactions').getOne(params.id);
      const data = { ...body };

      // Estorno original se era conta e realizada
      if (oldTxn.account_id && oldTxn.status === 'realized') {
        const account = await pb.collection('accounts').getOne(oldTxn.account_id);
        let revertedBalance = account.initial_balance;
        if (oldTxn.type === 'income') revertedBalance -= oldTxn.amount;
        if (oldTxn.type === 'expense') revertedBalance += oldTxn.amount;
        await pb.collection('accounts').update(oldTxn.account_id, { initial_balance: revertedBalance });
      }

      // ---------------------------------------------------------
      // APLICA NOVA REGRA 1: CONTA BANCÁRIA + REALIZADO
      // ---------------------------------------------------------
      if (data.account_id && data.status === 'realized') {
        const account = await pb.collection('accounts').getOne(data.account_id);
        let newBalance = account.initial_balance;
        if (data.type === 'income') newBalance += data.amount;
        if (data.type === 'expense') newBalance -= data.amount;
        
        await pb.collection('accounts').update(data.account_id, { initial_balance: newBalance });
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }

      // ---------------------------------------------------------
      // APLICA NOVA REGRA 2: CARTÃO DE CRÉDITO
      // ---------------------------------------------------------
      if (data.card_id && data.type === 'expense') {
        const card = await pb.collection('cards').getOne(data.card_id);
        const projectedDueDate = calculateCardDueDate(data.expected_date, card.closing_day, card.due_day);
        data.expected_date = projectedDueDate;
        data.status = 'pending'; 
      }

      const transaction = await pb.collection('transactions').update(params.id, data);
      return transaction;

    } catch (err: any) {
      console.error('Falha ao editar transação:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao editar transação', details: err.data || err.message };
    }
  });
