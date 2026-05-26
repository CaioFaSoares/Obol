import { Elysia, t } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { CardDTO, CardInvoicesResponseDTO, PayInvoiceDTO } from '../schemas/models';
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

  // GET /api/cards/:id/invoices — Faturas Físicas
  .get('/:id/invoices', async ({ params, pb, set }: { params: any, pb: PocketBase, set: any }) => {
    try {
      // 1. Busca as regras do cartão
      const card = await pb.collection('cards').getOne(params.id);

      // 2. Busca todas as faturas físicas desse cartão
      const invoices = await pb.collection('invoices').getFullList({
        filter: `card_id = '${card.id}'`,
        sort: '-period' // Ordena da mais recente pra mais antiga
      });

      // 3. Monta o DTO com as transações aninhadas
      const result = [];
      for (const inv of invoices) {
        const txns = await pb.collection('transactions').getFullList({
          filter: `invoice_id = '${inv.id}'`,
          sort: 'expected_date'
        });

        // Calcula o gasto bruto (ignorando estornos para exibição)
        let totalSpent = 0;
        for (const txn of txns) {
          if (txn.type === 'expense') totalSpent += txn.amount;
          if (txn.type === 'income' && !txn.title.toLowerCase().includes('pagamento')) {
            totalSpent -= txn.amount;
          }
        }

        result.push({
          period: inv.period,
          dueDate: inv.due_date,
          totalAmount: inv.total_amount - (inv.paid_amount || 0), // Saldo real devedor
          paidAmount: inv.paid_amount || 0,
          totalSpent: totalSpent,
          status: inv.status,
          transactions: txns.map(txn => ({
            id: txn.id,
            title: txn.title,
            amount: txn.amount,
            status: txn.status,
            expected_date: txn.expected_date,
            purchase_date: txn.purchase_date || null,
            recurrence_id: txn.recurrence_id || null
          }))
        });
      }
      // 4. Projeção da Próxima Fatura (virtual)
      // Calcula o próximo período baseado no mais recente existente ou no mês atual
      const now = new Date();
      const currentPeriod = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      
      // O próximo período é o mês seguinte ao mais recente existente, ou o mês seguinte ao atual
      const latestPeriod = result.length > 0 ? result[0].period : currentPeriod;
      const [ly, lm] = latestPeriod.split('-').map(Number);
      const nextMonth = lm === 12 ? 1 : lm + 1;
      const nextYear = lm === 12 ? ly + 1 : ly;
      const nextPeriod = `${nextYear}-${String(nextMonth).padStart(2, '0')}`;

      // Só projeta se o próximo período ainda não existe como fatura real
      const alreadyExists = result.some(r => r.period === nextPeriod);
      if (!alreadyExists) {
        // Busca recorrências ativas vinculadas a este cartão
        const recurrences = await pb.collection('recurrences').getFullList({
          filter: `card_id = '${card.id}' && status = 'active'`
        });

        if (recurrences.length > 0) {
          const projectedTxns: any[] = [];
          let projectedTotal = 0;

          for (const rec of recurrences) {
            // Verifica se o parcelamento já teria terminado
            let installmentLabel = '';
            if (rec.total_installments && rec.total_installments > 0) {
              const history = await pb.collection('transactions').getList(1, 1, {
                filter: `recurrence_id = '${rec.id}'`
              });
              const nextInstallment = history.totalItems + 1;
              if (nextInstallment > rec.total_installments) continue; // Já encerrado
              installmentLabel = ` - Parcela ${nextInstallment}/${rec.total_installments}`;
            }

            const amount = rec.amount;
            const delta = rec.type === 'expense' ? amount : -amount;
            projectedTotal += delta;

            projectedTxns.push({
              id: `projected-${rec.id}`,
              title: `${rec.name}${installmentLabel}`,
              amount: amount,
              status: 'projected',
              expected_date: `${nextPeriod}-${String(rec.payday).padStart(2, '0')}T00:00:00.000Z`,
              purchase_date: null,
              recurrence_id: rec.id
            });
          }

          if (projectedTxns.length > 0) {
            // Calcula a due_date projetada usando as regras do cartão
            const { calculateCardDueDate } = await import('../utils/dateUtils');
            const fakePurchaseDate = `${nextPeriod}-01T00:00:00.000Z`;
            const projectedDueDate = calculateCardDueDate(fakePurchaseDate, card.closing_day, card.due_day);

            result.unshift({
              period: nextPeriod,
              dueDate: projectedDueDate,
              totalAmount: projectedTotal,
              paidAmount: 0,
              totalSpent: projectedTotal,
              status: 'PROJECTED',
              transactions: projectedTxns
            });
          }
        }
      }

      return result as any;

    } catch (err: any) {
      set.status = 500;
      return { error: 'Falha ao buscar faturas', details: err.message };
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

      // 2. Buscamos a fatura física exata
      let invoice;
      try {
        invoice = await pb.collection('invoices').getFirstListItem(`card_id = '${params.id}' && period = '${period}'`);
      } catch (err) {
        set.status = 404;
        return { error: 'Fatura não encontrada para o período informado.' };
      }

      const totalDue = invoice.total_amount - (invoice.paid_amount || 0);
      let newBalance = account ? account.initial_balance : null;

      // 3. Executa as Mutações no Banco
      if (!ignore_balance) {
        if (!amount_paid || amount_paid <= 0) {
          set.status = 400;
          return { error: 'O valor pago deve ser maior que zero.' };
        }
        if (amount_paid > totalDue + 0.01) {
          set.status = 400;
          return { error: 'O valor pago não pode exceder o saldo devedor restante da fatura.' };
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

        // C. Atualiza o paid_amount da Fatura
        const newPaidAmount = (invoice.paid_amount || 0) + amount_paid;
        const remaining = invoice.total_amount - newPaidAmount;
        const isPartial = remaining > 0.01;

        if (isPartial) {
          await pb.collection('invoices').update(invoice.id, {
            paid_amount: newPaidAmount
          });
          return { 
            success: true, 
            message: `Pagamento parcial de R$ ${amount_paid} registrado com sucesso!`,
            new_account_balance: newBalance
          };
        } else {
          await pb.collection('invoices').update(invoice.id, {
            paid_amount: newPaidAmount,
            status: 'PAID'
          });
        }
      } else {
        // Baixa silenciosa completa a fatura
        await pb.collection('invoices').update(invoice.id, {
          status: 'PAID'
        });
      }

      // D. Quitação Total (Baixa nas transações filhas)
      const txns = await pb.collection('transactions').getFullList({
        filter: `invoice_id = '${invoice.id}' && status = 'pending'`,
      });
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
