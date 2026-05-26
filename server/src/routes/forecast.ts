import { Elysia, t } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { sum, sub, roundCurrency } from '../utils/mathUtils';
import { ForecastQueryDTO, ForecastResponseDTO } from '../schemas/models';
import { determineInvoiceStatus } from '../utils/dateUtils';

export const forecastRoutes = new Elysia({ prefix: '/api/forecast' })
  .use(pbPlugin)
  .get('/', async ({ query, pb, set }) => {
    try {
      const { startDate, endDate } = query;

      // 1. Snapshot Atual: Soma de todas as contas (excluindo investimentos)
      const accounts = await pb.collection('accounts').getFullList({
        filter: "type != 'investment'"
      });
      
      let currentBalance = accounts.reduce((sum, account) => sum + account.initial_balance, 0);

      // 2. Definimos o range de cálculo (sempre partindo de hoje no mínimo para não quebrar o futuro)
      const todayStr = new Date().toISOString().split('T')[0];
      const calcStartDateStr = startDate < todayStr ? startDate : todayStr;
      const startFilter = `${calcStartDateStr} 00:00:00.000Z`;

      // 3. Busca todas as transações relevantes (pendentes, realizadas a partir do início, ou recorrências do mês atual em diante)
      const startOfMonthStr = `${calcStartDateStr.substring(0, 7)}-01 00:00:00.000Z`;
      const transactions = await pb.collection('transactions').getFullList({
        filter: `status = 'pending' || realized_date >= '${startFilter}' || (recurrence_id != "" && expected_date >= '${startOfMonthStr}')`
      });

      // 4. Busca Recorrências
      const activeRecurrences = await pb.collection('recurrences').getFullList({
        filter: "status = 'active'"
      });

      // 4.5. Busca Faturas Físicas Abertas/Fechadas
      const invoices = await pb.collection('invoices').getFullList({
        filter: "status != 'PAID'",
        expand: 'card_id' // Para pegarmos o nome do cartão
      });
      
      const upcomingInvoices: { card_id: string, card_name: string, dateStr: string, amount: number, status: string }[] = [];

      for (const invoice of invoices) {
        const amountDue = sub(invoice.total_amount, invoice.paid_amount || 0);
        
        if (amountDue > 0) {
          // Garante que o status dinâmico entre OPEN/CLOSED é baseado na data de hoje
          const dueDate = new Date(invoice.due_date);
          const isClosed = new Date() > dueDate; 
          // (Poderíamos usar a função determineInvoiceStatus, mas como agora a fatura tem status físico, usamos ele. 
          // O status OPEN só vira CLOSED se a due_date já passou ou o closing_day passou. O syncInvoice ou outro cron faria isso, 
          // mas pro forecast o importante é o amountDue ser cobrado no due_date).
          
          upcomingInvoices.push({
            card_id: invoice.card_id,
            card_name: invoice.expand?.card_id?.name || 'Cartão',
            dateStr: invoice.due_date.substring(0, 10),
            amount: amountDue,
            status: invoice.status
          });
        }
      }

      // 5. Rollback: Encontrar o Saldo Inicial verdadeiro no calcStartDateStr
      let runningBalance = currentBalance;
      const realizedSinceStart = transactions.filter(t => t.status === 'realized' && t.realized_date >= startFilter && !t.card_id && !t.is_silent);
      for (const txn of realizedSinceStart) {
        if (txn.type === 'income') runningBalance = sub(runningBalance, txn.amount);
        if (txn.type === 'expense') runningBalance = sum(runningBalance, txn.amount);
      }
      
      // Ajuste de Dívidas Antigas: IGNORADO. Dívidas passadas não pagas não devem rebaixar artificialmente
      // o saldo bancário no gráfico. Elas devem ser gerenciadas apenas na aba 'Pendentes'.
      // const historicalPending = transactions.filter(t => t.status === 'pending' && t.expected_date < startFilter && !t.card_id);
      // for (const txn of historicalPending) {
      //  if (txn.type === 'income') runningBalance += txn.amount;
      //  if (txn.type === 'expense') runningBalance -= txn.amount;
      // }

      // 6. Algoritmo de Timeline (Iteração Dia a Dia)
      const timeline = [];
      let currentDate = new Date(`${calcStartDateStr}T00:00:00Z`);
      const finalDate = new Date(`${endDate}T00:00:00Z`);

      // Limite para ignorar dívidas fantasmas muito antigas (Ex: 30 dias atrás)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const limitGhostDebt = thirtyDaysAgo.toISOString();

      while (currentDate <= finalDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        
        // 1. TRANSAÇÕES REALIZADAS (Apenas do passado até hoje, baseadas na realized_date)
        if (dateStr <= todayStr) {
          const dailyRealized = transactions.filter(t => 
            t.status === 'realized' && 
            t.realized_date.startsWith(dateStr) && 
            !t.card_id && !t.is_silent
          );
          for (const txn of dailyRealized) {
            if (txn.type === 'income') runningBalance = sum(runningBalance, txn.amount);
            if (txn.type === 'expense') runningBalance = sub(runningBalance, txn.amount);
          }
        }

        // 2. TRANSAÇÕES PENDENTES (Processadas estritamente a partir de hoje e no futuro)
        // Pendências passadas não pagas não devem distorcer o histórico de saldo real.
        if (dateStr >= todayStr) {
          const dailyPending = transactions.filter(t => 
            t.status === 'pending' && 
            t.expected_date.startsWith(dateStr) && 
            !t.card_id
          );
          for (const txn of dailyPending) {
            console.log(`[FORECAST] Aplicando pendência (${txn.title}) de ${txn.amount} no dia ${dateStr}. Tipo: ${txn.type}`);
            if (txn.type === 'income') runningBalance = sum(runningBalance, txn.amount);
            if (txn.type === 'expense') runningBalance = sub(runningBalance, txn.amount);
          }
        }
        
        // 3. FATURAS DE CARTÃO DE CRÉDITO (Aplicadas estritamente na data de vencimento)
        const dailyInvoices = upcomingInvoices.filter(i => i.dateStr === dateStr);
        for (const inv of dailyInvoices) {
          runningBalance = sub(runningBalance, inv.amount);
        }

        // 4. SIMULAÇÃO DE RECORRÊNCIAS FUTURAS
        if (dateStr >= todayStr) {
          const dayOfMonth = currentDate.getUTCDate();
          const currentMonthStr = dateStr.substring(0, 7); 
          
          for (const rec of activeRecurrences) {
            if (rec.payday === dayOfMonth) {
              const alreadyLaunched = transactions.some(t => 
                t.recurrence_id === rec.id && 
                t.expected_date.startsWith(currentMonthStr)
              );

              if (!alreadyLaunched) {
                if (rec.type === 'income') runningBalance = sum(runningBalance, rec.amount);
                if (rec.type === 'expense') runningBalance = sub(runningBalance, rec.amount);
              }
            }
          }
        }

        // HIGIENE MATEMÁTICA E INJEÇÃO NA TIMELINE
        timeline.push({
          date: dateStr,
          balance: roundCurrency(runningBalance)
        });

        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      }

      // 7. Retorna apenas o range solicitado para a timeline
      // Para as faturas, retornamos todas (pois se estão abertas/fechadas, são devidas mesmo que atrasadas)
      const filteredInvoices = upcomingInvoices;

      return {
        timeline: timeline.filter(t => t.date >= startDate && t.date <= endDate),
        upcomingInvoices: filteredInvoices
      };

    } catch (err: any) {
      set.status = 500;
      return { error: 'Falha ao gerar projeção', details: err.message };
    }
  }, {
    query: ForecastQueryDTO, // Valida entrada
    response: { 
      200: ForecastResponseDTO,
      500: t.Object({ error: t.String(), details: t.Optional(t.String()) })
    } 
  });
