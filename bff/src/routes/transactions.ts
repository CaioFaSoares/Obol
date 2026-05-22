import { Elysia } from 'elysia';
import { TransactionDTO } from '../schemas/models';
import { calculateCardDueDate } from '../utils/dateUtils';
import type PocketBase from 'pocketbase';

export const transactionRoutes = new Elysia({ prefix: '/api/transactions' })
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

    } catch (error: any) {
      set.status = 400;
      return { error: 'Falha ao processar transação', details: error.message };
    }
  }, { 
    body: TransactionDTO // Validação estrita TypeBox de entrada
  });
