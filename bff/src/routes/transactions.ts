import { Elysia, t } from 'elysia';
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

      // ---------------------------------------------------------
      // REGRA 3: TRANSFERÊNCIA ENTRE CONTAS
      // ---------------------------------------------------------
      if (data.type === 'transfer' && data.account_id && data.destination_account_id && data.status === 'realized') {
        const sourceAcc = await pb.collection('accounts').getOne(data.account_id);
        const destAcc = await pb.collection('accounts').getOne(data.destination_account_id);
        
        const newSourceBalance = sourceAcc.initial_balance - data.amount;
        const newDestBalance = destAcc.initial_balance + data.amount;
        
        await pb.collection('accounts').update(sourceAcc.id, { initial_balance: newSourceBalance });
        await pb.collection('accounts').update(destAcc.id, { initial_balance: newDestBalance });
        
        data.category_id = null;
        data.card_id = null;
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }

      // Salva a transação final (seja da Regra 1, 2, 3 ou puras)
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
  .get('/', async ({ query, pb }: { query: any, pb: PocketBase }) => {
    try {
      const options: any = { sort: query?.sort || '-expected_date' };
      if (query?.filter) options.filter = query.filter;

      const records = await pb.collection('transactions').getList(1, 100, options);
      return records.items;
    } catch (err: any) {
      console.error('Falha ao listar transações:', err.data || err.message || err);
      return [];
    }
  }, {
    query: t.Optional(t.Object({
      filter: t.Optional(t.String()),
      sort: t.Optional(t.String())
    }))
  })

  // DELETE /api/transactions/:id — Deleta e estorna saldo se necessário
  .delete('/:id', async ({ params, pb, set }: { params: { id: string }, pb: PocketBase, set: any }) => {
    try {
      const oldTxn = await pb.collection('transactions').getOne(params.id);

      if (oldTxn.account_id && oldTxn.status === 'realized') {
        if (oldTxn.type === 'transfer' && oldTxn.destination_account_id) {
          const sourceAcc = await pb.collection('accounts').getOne(oldTxn.account_id);
          const destAcc = await pb.collection('accounts').getOne(oldTxn.destination_account_id);
          await pb.collection('accounts').update(sourceAcc.id, { initial_balance: sourceAcc.initial_balance + oldTxn.amount });
          await pb.collection('accounts').update(destAcc.id, { initial_balance: destAcc.initial_balance - oldTxn.amount });
        } else {
          const account = await pb.collection('accounts').getOne(oldTxn.account_id);
          let revertedBalance = account.initial_balance;
          
          if (oldTxn.type === 'income') revertedBalance -= oldTxn.amount;
          if (oldTxn.type === 'expense') revertedBalance += oldTxn.amount;

          await pb.collection('accounts').update(oldTxn.account_id, { 
            initial_balance: revertedBalance 
          });
        }
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
        if (oldTxn.type === 'transfer' && oldTxn.destination_account_id) {
          const sourceAcc = await pb.collection('accounts').getOne(oldTxn.account_id);
          const destAcc = await pb.collection('accounts').getOne(oldTxn.destination_account_id);
          await pb.collection('accounts').update(sourceAcc.id, { initial_balance: sourceAcc.initial_balance + oldTxn.amount });
          await pb.collection('accounts').update(destAcc.id, { initial_balance: destAcc.initial_balance - oldTxn.amount });
        } else {
          const account = await pb.collection('accounts').getOne(oldTxn.account_id);
          let revertedBalance = account.initial_balance;
          if (oldTxn.type === 'income') revertedBalance -= oldTxn.amount;
          if (oldTxn.type === 'expense') revertedBalance += oldTxn.amount;
          await pb.collection('accounts').update(oldTxn.account_id, { initial_balance: revertedBalance });
        }
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
        data.purchase_date = data.expected_date; // Salva a data real da compra
        data.expected_date = projectedDueDate;
        data.status = 'pending'; 
      }

      // ---------------------------------------------------------
      // APLICA NOVA REGRA 3: TRANSFERÊNCIA
      // ---------------------------------------------------------
      if (data.type === 'transfer' && data.account_id && data.destination_account_id && data.status === 'realized') {
        const sourceAcc = await pb.collection('accounts').getOne(data.account_id);
        const destAcc = await pb.collection('accounts').getOne(data.destination_account_id);
        
        await pb.collection('accounts').update(sourceAcc.id, { initial_balance: sourceAcc.initial_balance - data.amount });
        await pb.collection('accounts').update(destAcc.id, { initial_balance: destAcc.initial_balance + data.amount });
        
        data.category_id = null;
        data.card_id = null;
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }

      const transaction = await pb.collection('transactions').update(params.id, data);
      return transaction;

    } catch (err: any) {
      console.error('Falha ao editar transação:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao editar transação', details: err.data || err.message };
    }
  })

  // PATCH /api/transactions/:id/realize — Transforma pendente em realizada e abate saldo
  .patch('/:id/realize', async ({ params, body, pb, set }: { params: { id: string }, body: any, pb: PocketBase, set: any }) => {
    try {
      const txn = await pb.collection('transactions').getOne(params.id);
      
      if (txn.status === 'realized') {
        set.status = 400;
        return { error: 'Transação já foi realizada.' };
      }

      const shouldUpdateBalance = body.update_balance !== false;

      if (txn.type === 'transfer' && txn.account_id && txn.destination_account_id && shouldUpdateBalance) {
        const sourceAcc = await pb.collection('accounts').getOne(txn.account_id);
        const destAcc = await pb.collection('accounts').getOne(txn.destination_account_id);
        
        await pb.collection('accounts').update(sourceAcc.id, { 
          initial_balance: sourceAcc.initial_balance - txn.amount 
        });
        await pb.collection('accounts').update(destAcc.id, { 
          initial_balance: destAcc.initial_balance + txn.amount 
        });
      } else if (txn.account_id && shouldUpdateBalance) {
        const account = await pb.collection('accounts').getOne(txn.account_id);
        
        let newBalance = account.initial_balance;
        if (txn.type === 'income') newBalance += txn.amount;
        if (txn.type === 'expense') newBalance -= txn.amount;
        
        await pb.collection('accounts').update(account.id, { 
          initial_balance: newBalance 
        });
      }

      const updatedTxn = await pb.collection('transactions').update(txn.id, {
        status: 'realized',
        realized_date: new Date().toISOString()
      });

      return updatedTxn;

    } catch (error: any) {
      console.error('Falha ao dar baixa:', error);
      set.status = 500;
      return { error: 'Falha ao realizar transação', details: error.message };
    }
  }, {
    body: t.Object({
      update_balance: t.Optional(t.Boolean({ default: true }))
    })
  });
