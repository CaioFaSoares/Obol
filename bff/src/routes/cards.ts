import { Elysia, t } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { CardDTO, CardInvoicesResponseDTO, PayInvoiceDTO } from '../schemas/models';
import { determineInvoiceStatus } from '../utils/dateUtils';
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
  })

  // PATCH /api/cards/:id — Atualiza um cartão existente
  .patch('/:id', async ({ params, body, pb, set }: { params: any, body: any, pb: PocketBase, set: any }) => {
    try {
      const record = await pb.collection('cards').update(params.id, body);
      return record;
    } catch (err: any) {
      console.error('Falha ao atualizar cartão:', err.data || err.message || err);
      set.status = err.status || 400;
      return { error: 'Falha ao atualizar cartão', details: err.data || err.message };
    }
  })

  // GET /api/cards/:id/invoices — Faturas Virtuais
  .get('/:id/invoices', async ({ params, pb, set }: { params: any, pb: PocketBase, set: any }) => {
    try {
      // 1. Busca as regras do cartão
      const card = await pb.collection('cards').getOne(params.id);

      // 2. Busca todas as transações atreladas a esse cartão
      const txns = await pb.collection('transactions').getFullList({
        filter: `card_id = '${card.id}'`,
        sort: 'expected_date' // Ordena cronologicamente
      });

      // 3. O Agrupador (Reduce)
      const invoicesMap = new Map();

      for (const txn of txns) {
        // Extrai a data exata (YYYY-MM-DD) para alinhar com o forecast
        const exactDueDate = txn.expected_date.substring(0, 10);
        
        if (!invoicesMap.has(exactDueDate)) {
          invoicesMap.set(exactDueDate, {
            period: exactDueDate, // Usamos o exato dia como identificador da fatura agora
            dueDate: txn.expected_date,
            totalAmount: 0,
            totalSpent: 0,
            status: 'OPEN',
            transactions: []
          });
        }

        const invoice = invoicesMap.get(exactDueDate);
        
        // Saldo Devedor Restante
        if (txn.status === 'pending') {
          if (txn.type === 'expense') invoice.totalAmount += txn.amount;
          if (txn.type === 'income') invoice.totalAmount -= txn.amount;
        }

        // Total Gasto Bruto do Mês
        if (txn.type === 'expense') invoice.totalSpent += txn.amount;
        if (txn.type === 'income' && !txn.title.toLowerCase().includes('pagamento')) {
          invoice.totalSpent -= txn.amount;
        }
        
        invoice.transactions.push({
          id: txn.id,
          title: txn.title,
          amount: txn.amount,
          status: txn.status,
          expected_date: txn.expected_date
        });
      }

      // 4. Consolidação e Cálculo de Status
      const result = Array.from(invoicesMap.values()).map(invoice => {
        invoice.status = determineInvoiceStatus(
          invoice.transactions,
          invoice.dueDate,
          card.closing_day,
          card.due_day
        );
        return invoice;
      });

      return result.sort((a, b) => b.period.localeCompare(a.period)) as any;

    } catch (err: any) {
      set.status = 500;
      return { error: 'Falha ao gerar faturas', details: err.message };
    }
  }, {
    response: { 
      200: CardInvoicesResponseDTO,
      500: t.Object({ error: t.String(), details: t.Optional(t.Any()) })
    }
  })

  // POST /api/cards/:id/pay-invoice — Liquidação de Fatura
  .post('/:id/pay-invoice', async ({ params, body, pb, set }: { params: any, body: any, pb: PocketBase, set: any }) => {
    try {
      const { period, account_id, amount_paid, ignore_balance } = body;

      // 1. Validamos o cartão (a conta só é validada se não for baixa silenciosa)
      const card = await pb.collection('cards').getOne(params.id);
      let account = null;
      if (!ignore_balance) {
        if (!account_id) throw new Error('account_id é obrigatório quando não é baixa silenciosa.');
        account = await pb.collection('accounts').getOne(account_id);
      }

      // 2. Buscamos as transações pela DATA EXATA da fatura (que agora vem no period)
      // Como o expected_date tem timestamp, pegamos o dia inteiro:
      // Nota: Para suportar legados, period pode vir como YYYY-MM ou YYYY-MM-DD
      let dateFilter = "";
      if (period.length === 7) {
        // Legado (se o front mandar só YYYY-MM)
        dateFilter = `expected_date >= '${period}-01 00:00:00.000Z' && expected_date <= '${period}-31 23:59:59.999Z'`;
      } else {
        // Novo padrão (YYYY-MM-DD)
        dateFilter = `expected_date >= '${period} 00:00:00.000Z' && expected_date <= '${period} 23:59:59.999Z'`;
      }

      const txns = await pb.collection('transactions').getFullList({
        filter: `card_id = '${params.id}' && ${dateFilter} && status = 'pending'`,
      });

      if (txns.length === 0) {
        set.status = 400;
        return { error: 'Nenhuma transação pendente encontrada para esta fatura.' };
      }

      // 3. Calculamos o valor real devido para checagem de segurança
      let totalDue = 0;
      for (const txn of txns) {
        if (txn.type === 'expense') totalDue += txn.amount;
        if (txn.type === 'income') totalDue -= txn.amount;
      }

      let newBalance = account ? account.initial_balance : null;

      // 4. Executa as Mutações no Banco

      if (!ignore_balance) {
        if (!amount_paid || amount_paid <= 0) {
          set.status = 400;
          return { error: 'O valor pago deve ser maior que zero.' };
        }
        if (amount_paid > totalDue + 0.01) {
          set.status = 400;
          return { error: 'O valor pago não pode exceder o saldo devedor da fatura.' };
        }

        // A. Abate o saldo da Conta Corrente
        if (!account) throw new Error('Conta não encontrada ou não informada.');
        
        newBalance = account.initial_balance - amount_paid;
        await pb.collection('accounts').update(account.id, { 
          initial_balance: newBalance 
        });

        // B. Registra a saída da conta corrente no histórico
        await pb.collection('transactions').create({
          title: `Pagamento Fatura ${card.name} ${period}`,
          amount: amount_paid,
          type: 'expense',
          status: 'realized',
          account_id: account.id,
          realized_date: new Date().toISOString(),
          expected_date: new Date().toISOString()
        });

        // Pagamento Parcial (Só é suportado quando há pagamento real em dinheiro)
        const isPartial = amount_paid < totalDue - 0.01;
        if (isPartial) {
          await pb.collection('transactions').create({
            title: `Pagamento Parcial ${card.name}`,
            amount: amount_paid,
            type: 'income',
            status: 'pending',
            card_id: params.id,
            expected_date: `${period.substring(0, 7)}-15T12:00:00.000Z` // Joga pra frente provisoriamente
          });
          return { 
            success: true, 
            message: `Pagamento parcial de R$ ${amount_paid} registrado com sucesso!`,
            new_account_balance: newBalance
          };
        }
      }

      // C. Update em Massa (Quitação Total ou Baixa Silenciosa)
      const updatePromises = txns.map(txn => 
        pb.collection('transactions').update(txn.id, {
          status: 'realized',
          realized_date: new Date().toISOString()
        })
      );
      await Promise.all(updatePromises);

      return { 
        success: true, 
        message: ignore_balance ? `Fatura resolvida silenciosamente!` : `Fatura de ${period} quitada!`,
        new_account_balance: newBalance
      };

    } catch (error: any) {
      set.status = 500;
      return { error: 'Falha ao liquidar fatura', details: error.message };
    }
  }, {
    body: PayInvoiceDTO
  });
