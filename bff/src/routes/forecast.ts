import { Elysia, t } from 'elysia';
import { pbPlugin } from '../plugins/pocketbase';
import { ForecastQueryDTO, ForecastResponseDTO } from '../schemas/models';

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

      // 3. Busca todas as transações relevantes (pendentes ou realizadas a partir do início do cálculo)
      const transactions = await pb.collection('transactions').getFullList({
        filter: `status = 'pending' || realized_date >= '${startFilter}'`
      });

      // 4. Busca Recorrências
      const activeRecurrences = await pb.collection('recurrences').getFullList({
        filter: "status = 'active'"
      });

      // 5. Rollback: Encontrar o Saldo Inicial verdadeiro no calcStartDateStr
      let runningBalance = currentBalance;
      const realizedSinceStart = transactions.filter(t => t.status === 'realized' && t.realized_date >= startFilter);
      for (const txn of realizedSinceStart) {
        if (txn.type === 'income') runningBalance -= txn.amount;
        if (txn.type === 'expense') runningBalance += txn.amount;
      }

      // 6. Algoritmo de Timeline (Iteração Dia a Dia)
      const timeline = [];
      let currentDate = new Date(`${calcStartDateStr}T00:00:00Z`);
      const finalDate = new Date(`${endDate}T00:00:00Z`);

      while (currentDate <= finalDate) {
        const dateStr = currentDate.toISOString().split('T')[0];
        
        if (dateStr <= todayStr) {
          // PASSADO OU HOJE: Aplica as transações que realmente aconteceram
          const dailyRealized = transactions.filter(t => t.status === 'realized' && t.realized_date.startsWith(dateStr));
          for (const txn of dailyRealized) {
            if (txn.type === 'income') runningBalance += txn.amount;
            if (txn.type === 'expense') runningBalance -= txn.amount;
          }
        }

        if (dateStr === todayStr) {
          // HOJE: Aplica todas as transações pendentes atrasadas ou do dia
          const overduePending = transactions.filter(t => t.status === 'pending' && t.expected_date <= `${dateStr} 23:59:59`);
          for (const txn of overduePending) {
            if (txn.type === 'income') runningBalance += txn.amount;
            if (txn.type === 'expense') runningBalance -= txn.amount;
          }
        }

        if (dateStr > todayStr) {
          // FUTURO: Aplica transações pendentes agendadas para o dia
          const dailyPending = transactions.filter(t => t.status === 'pending' && t.expected_date.startsWith(dateStr));
          for (const txn of dailyPending) {
            if (txn.type === 'income') runningBalance += txn.amount;
            if (txn.type === 'expense') runningBalance -= txn.amount;
          }
          
          // FUTURO: Simula recorrências que caem no dia
          const dayOfMonth = currentDate.getUTCDate();
          for (const rec of activeRecurrences) {
            if (rec.payday === dayOfMonth) {
              if (rec.type === 'income') runningBalance += rec.amount;
              if (rec.type === 'expense') runningBalance -= rec.amount;
            }
          }
        }

        timeline.push({
          date: dateStr,
          balance: runningBalance
        });

        currentDate.setUTCDate(currentDate.getUTCDate() + 1);
      }

      // 7. Retorna apenas o range solicitado
      return timeline.filter(t => t.date >= startDate && t.date <= endDate);

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
