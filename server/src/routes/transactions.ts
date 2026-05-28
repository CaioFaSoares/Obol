import { Elysia, t } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { TransactionDTO } from '../schemas/models';
import { calculateCardDueDate } from '../utils/dateUtils';
import { syncInvoice } from '../services/invoiceService';
import { sum, sub } from '../utils/mathUtils';
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
        if (data.type === 'income') newBalance = sum(newBalance, data.amount);
        if (data.type === 'expense') newBalance = sub(newBalance, data.amount);
        
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
      if (data.card_id) {
        // A data de compra informada (expected_date no form) vira a purchase_date real
        const purchaseDate = data.expected_date;
        const invoice = await syncInvoice(pb, data.card_id, purchaseDate, data.amount, data.type);
        
        data.invoice_id = invoice.id;
        data.purchase_date = purchaseDate;
        data.expected_date = invoice.due_date; // Move a cobrança para a data de vencimento da fatura
        data.status = 'pending'; // Gastos de cartão SEMPRE nascem pendentes
      }

      // ---------------------------------------------------------
      // REGRA 3: TRANSFERÊNCIA ENTRE CONTAS
      // ---------------------------------------------------------
      if (data.type === 'transfer' && data.account_id && data.destination_account_id && data.status === 'realized') {
        const sourceAcc = await pb.collection('accounts').getOne(data.account_id);
        const destAcc = await pb.collection('accounts').getOne(data.destination_account_id);
        
        const newSourceBalance = sub(sourceAcc.initial_balance, data.amount);
        const newDestBalance = sum(destAcc.initial_balance, data.amount);
        
        await pb.collection('accounts').update(sourceAcc.id, { initial_balance: newSourceBalance });
        await pb.collection('accounts').update(destAcc.id, { initial_balance: newDestBalance });
        
        data.category_id = null;
        data.card_id = null;
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }

      if (data.status === 'realized') {
        data.is_scheduled = false;
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

  // GET /api/transactions — Lista as transações paginadas
  .get('/', async ({ query, pb }: { query: any, pb: PocketBase }) => {
    try {
      // 1. Captura os parâmetros de paginação da Query, com defaults inteligentes
      const page = Number(query?.page) || 1;
      const perPage = Number(query?.perPage) || 15;

      const options: any = { sort: query?.sort || '-expected_date' };
      if (query?.filter) options.filter = query.filter;

      // 2. Realiza a busca no PocketBase utilizando a paginação dinâmica
      const records = await pb.collection('transactions').getList(page, perPage, options);
      
      // 3. RETORNO ALTERADO: Em vez de devolver records.items diretamente, 
      // devolvemos o objeto completo para o frontend ter metadados de paginação.
      return {
        items: records.items,
        page: records.page,
        perPage: records.perPage,
        totalItems: records.totalItems,
        totalPages: records.totalPages
      };
    } catch (err: any) {
      console.error('Falha ao listar transações:', err);
      return { items: [], page: 1, totalPages: 0, totalItems: 0 };
    }
  }, {
    query: t.Optional(t.Object({
      filter: t.Optional(t.String()),
      sort: t.Optional(t.String()),
      page: t.Optional(t.String()),
      perPage: t.Optional(t.String())
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
          await pb.collection('accounts').update(sourceAcc.id, { initial_balance: sum(sourceAcc.initial_balance, oldTxn.amount) });
          await pb.collection('accounts').update(destAcc.id, { initial_balance: sub(destAcc.initial_balance, oldTxn.amount) });
        } else {
          const account = await pb.collection('accounts').getOne(oldTxn.account_id);
          let revertedBalance = account.initial_balance;
          
          if (oldTxn.type === 'income') revertedBalance = sub(revertedBalance, oldTxn.amount);
          if (oldTxn.type === 'expense') revertedBalance = sum(revertedBalance, oldTxn.amount);

          await pb.collection('accounts').update(oldTxn.account_id, { 
            initial_balance: revertedBalance 
          });
        }
      }

      // REGRA DE FATURAS FÍSICAS: Estornar do total_amount da fatura pai
      if (oldTxn.card_id && oldTxn.invoice_id) {
        try {
          const invoice = await pb.collection('invoices').getOne(oldTxn.invoice_id);
          const amountDelta = oldTxn.type === 'expense' ? -oldTxn.amount : oldTxn.amount;
          await pb.collection('invoices').update(invoice.id, {
            total_amount: sum(invoice.total_amount, amountDelta)
          });

          if (oldTxn.recurrence_id) {
             const rec = await pb.collection('recurrences').getOne(oldTxn.recurrence_id);
             let skipped = rec.skipped_periods || [];
             const pDate = oldTxn.purchase_date || oldTxn.expected_date;
             const purchasePeriod = pDate.substring(0, 7);
             if (!skipped.includes(purchasePeriod)) skipped.push(purchasePeriod);
             if (!skipped.includes(invoice.period)) skipped.push(invoice.period);
             await pb.collection('recurrences').update(rec.id, { skipped_periods: skipped });
          }
        } catch(e) {
          console.error("Fatura não encontrada para estorno.");
        }
      } else if (oldTxn.recurrence_id) {
         try {
             const rec = await pb.collection('recurrences').getOne(oldTxn.recurrence_id);
             let skipped = rec.skipped_periods || [];
             const pDate = oldTxn.purchase_date || oldTxn.expected_date;
             const purchasePeriod = pDate.substring(0, 7);
             if (!skipped.includes(purchasePeriod)) {
                 skipped.push(purchasePeriod);
                 await pb.collection('recurrences').update(rec.id, { skipped_periods: skipped });
             }
         } catch(e) {}
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
          await pb.collection('accounts').update(sourceAcc.id, { initial_balance: sum(sourceAcc.initial_balance, oldTxn.amount) });
          await pb.collection('accounts').update(destAcc.id, { initial_balance: sub(destAcc.initial_balance, oldTxn.amount) });
        } else {
          const account = await pb.collection('accounts').getOne(oldTxn.account_id);
          let revertedBalance = account.initial_balance;
          if (oldTxn.type === 'income') revertedBalance = sub(revertedBalance, oldTxn.amount);
          if (oldTxn.type === 'expense') revertedBalance = sum(revertedBalance, oldTxn.amount);
          await pb.collection('accounts').update(oldTxn.account_id, { initial_balance: revertedBalance });
        }
      }

      // ---------------------------------------------------------
      // APLICA NOVA REGRA 1: CONTA BANCÁRIA + REALIZADO
      // ---------------------------------------------------------
      if (data.account_id && data.status === 'realized') {
        const account = await pb.collection('accounts').getOne(data.account_id);
        let newBalance = account.initial_balance;
        if (data.type === 'income') newBalance = sum(newBalance, data.amount);
        if (data.type === 'expense') newBalance = sub(newBalance, data.amount);
        
        await pb.collection('accounts').update(data.account_id, { initial_balance: newBalance });
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }

      // ---------------------------------------------------------
      // ESTORNO DE FATURA DE CARTÃO (SE EXISTIA)
      // ---------------------------------------------------------
      if (oldTxn.card_id && oldTxn.invoice_id) {
        // Verifica se precisamos estornar: mudou o cartão, valor, tipo, data ou virou conta
        const changedCard = data.card_id !== undefined && data.card_id !== oldTxn.card_id;
        const changedAmountOrType = (data.amount !== undefined && data.amount !== oldTxn.amount) || (data.type !== undefined && data.type !== oldTxn.type);
        const changedDate = data.expected_date !== undefined && data.expected_date !== oldTxn.expected_date;
        
        if (changedCard || changedAmountOrType || changedDate) {
          try {
            const oldInvoice = await pb.collection('invoices').getOne(oldTxn.invoice_id);
            const oldAmountDelta = oldTxn.type === 'expense' ? -oldTxn.amount : oldTxn.amount;
            await pb.collection('invoices').update(oldInvoice.id, {
              total_amount: sum(oldInvoice.total_amount, oldAmountDelta)
            });
          } catch(e) {}
          
          if (!data.card_id) {
            data.invoice_id = null;
            data.purchase_date = null;
          }
        }
      }

      // ---------------------------------------------------------
      // APLICA NOVA REGRA 2: CARTÃO DE CRÉDITO
      // ---------------------------------------------------------
      if (data.card_id) {
        // 2. Associa e soma à nova fatura (apenas se mudou algo ou se é novo)
        const changedCard = data.card_id !== undefined && data.card_id !== oldTxn.card_id;
        const changedAmountOrType = (data.amount !== undefined && data.amount !== oldTxn.amount) || (data.type !== undefined && data.type !== oldTxn.type);
        const changedDate = data.expected_date !== undefined && data.expected_date !== oldTxn.expected_date;

        if (changedCard || changedAmountOrType || changedDate || !oldTxn.card_id) {
          const baseDate = data.expected_date || oldTxn.purchase_date || oldTxn.expected_date;
          const newAmount = data.amount || oldTxn.amount;
          const newType = data.type || oldTxn.type;
          
          const invoice = await syncInvoice(pb, data.card_id, baseDate, newAmount, newType);
          
          data.invoice_id = invoice.id;
          data.purchase_date = baseDate;
          data.expected_date = invoice.due_date;
          data.status = 'pending'; 
        }
      }

      // ---------------------------------------------------------
      // APLICA NOVA REGRA 3: TRANSFERÊNCIA
      // ---------------------------------------------------------
      if (data.type === 'transfer' && data.account_id && data.destination_account_id && data.status === 'realized') {
        const sourceAcc = await pb.collection('accounts').getOne(data.account_id);
        const destAcc = await pb.collection('accounts').getOne(data.destination_account_id);
        
        await pb.collection('accounts').update(sourceAcc.id, { initial_balance: sub(sourceAcc.initial_balance, data.amount) });
        await pb.collection('accounts').update(destAcc.id, { initial_balance: sum(destAcc.initial_balance, data.amount) });
        
        data.category_id = null;
        data.card_id = null;
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }

      if (data.status === 'realized') {
        data.is_scheduled = false;
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
          initial_balance: sub(sourceAcc.initial_balance, txn.amount) 
        });
        await pb.collection('accounts').update(destAcc.id, { 
          initial_balance: sum(destAcc.initial_balance, txn.amount) 
        });
      } else if (txn.account_id && shouldUpdateBalance) {
        const account = await pb.collection('accounts').getOne(txn.account_id);
        
        let newBalance = account.initial_balance;
        if (txn.type === 'income') newBalance = sum(newBalance, txn.amount);
        if (txn.type === 'expense') newBalance = sub(newBalance, txn.amount);
        
        await pb.collection('accounts').update(account.id, { 
          initial_balance: newBalance 
        });
      }

      const updatedTxn = await pb.collection('transactions').update(txn.id, {
        status: 'realized',
        realized_date: new Date().toISOString(),
        is_silent: !shouldUpdateBalance,
        is_scheduled: false
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
