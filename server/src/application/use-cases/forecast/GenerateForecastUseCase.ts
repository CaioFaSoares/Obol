import { Account } from '../../../domain/entities/Account';
import { Card } from '../../../domain/entities/Card';
import { Invoice } from '../../../domain/entities/Invoice';
import { Transaction } from '../../../domain/entities/Transaction';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import {
  addUtcDays,
  addUtcMonths,
  calculateCardDueDate,
  calculateClosingDate,
  calculateClampedDate,
  dayKey,
  daysInUtcMonth,
  isoWeekOccurrence,
  monthKey,
  startOfIsoWeek,
  startOfUtcDay,
  startOfUtcMonth
} from '../../../domain/utils/dateUtils';
import {
  recurrenceCadence,
  recurrenceChildKey,
  recurrencePeriodKey
} from '../../../domain/recurrence/cadence';
import { roundCurrency } from '../../../domain/utils/mathUtils';
import { SyncClock, systemSyncClock } from '../../../domain/sync/MutationContext';

interface ForecastQuery {
  startDate: string;
  endDate: string;
  includeSimulations?: string;
}

interface ForecastTimelineEntry {
  date: string;
  balance: number;
}

interface ForecastInvoiceEntry {
  card_id: string;
  card_name: string;
  dateStr: string;
  amount: number;
  status: string;
}

interface ForecastResponse {
  timeline: ForecastTimelineEntry[];
  upcomingInvoices: ForecastInvoiceEntry[];
}

interface DatedAmount {
  day: Date;
  amount: number;
}

/**
 * End-of-day cash projection.
 *
 * The starting value is current liquid cash (non-investment account
 * balances). Past days reconstruct only realized, non-silent, non-simulated
 * cash effects; today and future days include projected obligations. An
 * expense or income row without an account still affects the aggregate
 * forecast while pending; a realized row without an account never invents a
 * historical cash movement.
 */
export class GenerateForecastUseCase {
  constructor(
    private readonly accountRepository: AccountRepository,
    private readonly transactionRepository: TransactionRepository,
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly cardRepository: CardRepository,
    private readonly clock: SyncClock = systemSyncClock
  ) {}

  async execute(query: ForecastQuery): Promise<ForecastResponse> {
    const start = startOfUtcDay(`${query.startDate.substring(0, 10)}T00:00:00.000Z`);
    const end = startOfUtcDay(`${query.endDate.substring(0, 10)}T00:00:00.000Z`);
    if (start > end) {
      throw new ValidationError('Forecast start date must be on or before the end date.');
    }

    const today = startOfUtcDay(this.clock.now());
    const calcStart = start < today ? start : today;
    const includeSimulations = query.includeSimulations === 'true';

    const accounts = await this.accountRepository.listAll();
    const accountsById = new Map(accounts.map(account => [account.id, account]));
    const transactions = await this.transactionRepository.listAll();
    const activeRecurrences = (await this.recurrenceRepository.listAll())
      .filter(rec => rec.status === 'active');
    const invoices = await this.invoiceRepository.listAll();

    let balance = 0;
    for (const account of accounts) {
      if (account.type !== 'investment') balance = roundCurrency(balance + account.initial_balance);
    }

    // Roll liquid cash back to the first day of the calculation window.
    for (const txn of transactions) {
      if (txn.status !== 'realized' || txn.is_silent === true || txn.is_simulated === true) continue;
      if (!txn.realized_date) continue;
      const realizedDay = startOfUtcDay(txn.realized_date);
      if (realizedDay < calcStart || realizedDay > today) continue;
      balance = roundCurrency(balance - this.cashEffect(txn, accountsById));
    }

    const invoiceEvents: DatedAmount[] = [];
    const upcomingInvoices: ForecastInvoiceEntry[] = [];
    const cardCache = new Map<string, Card | null>();

    for (const invoice of invoices) {
      const card = await this.findCard(invoice.card_id, cardCache);
      if (!card) continue;

      const children = transactions.filter(t => t.invoice_id === invoice.id);
      const status = this.effectiveInvoiceStatus(invoice, children, card, today);
      const amountDue = roundCurrency(invoice.total_amount - (invoice.paid_amount ?? 0));
      if (status === 'PAID' || amountDue <= 0) continue;

      upcomingInvoices.push({
        card_id: invoice.card_id,
        card_name: card.name,
        dateStr: invoice.due_date.substring(0, 10),
        amount: amountDue,
        status
      });

      // An overdue unpaid invoice is projected today. Its stored due date is
      // never changed and it is never marked realized.
      const dueDay = startOfUtcDay(invoice.due_date);
      const eventDay = dueDay < today ? today : dueDay;
      if (eventDay >= calcStart && eventDay <= end) {
        invoiceEvents.push({ day: eventDay, amount: -amountDue });
      }
    }

    upcomingInvoices.sort((a, b) => {
      if (a.dateStr !== b.dateStr) return a.dateStr < b.dateStr ? -1 : 1;
      return a.card_name < b.card_name ? -1 : a.card_name > b.card_name ? 1 : 0;
    });

    // Active recurrences project one occurrence per period: the clamped payday
    // of each month for monthly rows, each ISO week occurrence for weekly rows.
    // Card recurrences land on their invoice due date; direct recurrences on
    // the occurrence date. An occurrence already launched for its period is
    // skipped.
    const recurrenceEvents: DatedAmount[] = [];
    if (today <= end) {
      const firstMonth = startOfUtcMonth(today);
      const lastMonth = startOfUtcMonth(end);

      for (const rec of activeRecurrences) {
        const recTransactions = transactions.filter(t => t.recurrence_id === rec.id);
        let projectedCount = recTransactions.length;

        // A weekly rule projects one event per ISO week inside the horizon.
        // Weekly dates are exact and an occurrence already launched for its
        // day is skipped; there is never a monthly equivalent.
        if (recurrenceCadence(rec) === 'weekly') {
          const weekday = rec.weekday ?? 0;
          let weekStart = startOfIsoWeek(today);

          while (weekStart <= end) {
            const occurrence = isoWeekOccurrence(weekStart, weekday);
            const occurrenceDay = new Date(occurrence);

            if (rec.end_date && occurrenceDay > new Date(rec.end_date)) break;

            const period = recurrencePeriodKey('weekly', occurrence);
            const skipped = rec.skipped_periods || [];
            if (skipped.includes(period)) {
              weekStart = addUtcDays(weekStart, 7);
              continue;
            }

            let cardDueDate: Date | null = null;
            if (rec.card_id) {
              const card = await this.findCard(rec.card_id, cardCache);
              if (!card) throw new NotFoundError(`Card ${rec.card_id} was not found.`);
              cardDueDate = startOfUtcDay(
                calculateCardDueDate(occurrence, card.closing_day, card.due_day)
              );
            }

            const launched = recTransactions.some(
              txn => recurrenceChildKey(rec, txn) === period
            );
            if (launched) {
              weekStart = addUtcDays(weekStart, 7);
              continue;
            }

            if (rec.total_installments && rec.total_installments > 0 && projectedCount + 1 > rec.total_installments) {
              break;
            }

            const amount = rec.type === 'expense' ? -roundCurrency(rec.amount) : roundCurrency(rec.amount);
            const baseDay = cardDueDate ?? startOfUtcDay(occurrence);
            const eventDay = this.latestDay(baseDay, today, calcStart);
            if (eventDay <= end) {
              recurrenceEvents.push({ day: eventDay, amount });
            }
            projectedCount += 1;
            weekStart = addUtcDays(weekStart, 7);
          }
          continue;
        }

        let monthStart = firstMonth;

        while (monthStart <= lastMonth) {
          const year = monthStart.getUTCFullYear();
          const month = monthStart.getUTCMonth();
          const occurrence = calculateClampedDate(
            year,
            month,
            rec.payday,
            daysInUtcMonth(year, month)
          );
          const occurrenceDay = new Date(occurrence);

          if (rec.end_date && occurrenceDay > new Date(rec.end_date)) break;

          const period = monthKey(occurrence);
          const skipped = rec.skipped_periods || [];
          if (skipped.includes(period)) {
            monthStart = addUtcMonths(monthStart, 1);
            continue;
          }

          let cardDueDate: Date | null = null;
          if (rec.card_id) {
            const card = await this.findCard(rec.card_id, cardCache);
            if (!card) throw new NotFoundError(`Card ${rec.card_id} was not found.`);
            cardDueDate = startOfUtcDay(
              calculateCardDueDate(occurrence, card.closing_day, card.due_day)
            );
            if (skipped.includes(monthKey(cardDueDate))) {
              monthStart = addUtcMonths(monthStart, 1);
              continue;
            }
          }

          const launched = recTransactions.some(txn => {
            const purchaseMonth = txn.purchase_date ? monthKey(txn.purchase_date) : null;
            const expectedMonth = monthKey(txn.expected_date);
            if (rec.card_id) return (purchaseMonth ?? expectedMonth) === period;
            return purchaseMonth === period || expectedMonth === period;
          });
          if (launched) {
            monthStart = addUtcMonths(monthStart, 1);
            continue;
          }

          if (rec.total_installments && rec.total_installments > 0 && projectedCount + 1 > rec.total_installments) {
            break;
          }

          const amount = rec.type === 'expense' ? -roundCurrency(rec.amount) : roundCurrency(rec.amount);
          const baseDay = cardDueDate ?? startOfUtcDay(occurrence);
          const eventDay = this.latestDay(baseDay, today, calcStart);
          if (eventDay <= end) {
            recurrenceEvents.push({ day: eventDay, amount });
          }
          projectedCount += 1;
          monthStart = addUtcMonths(monthStart, 1);
        }
      }
    }

    const timeline: ForecastTimelineEntry[] = [];
    let day = new Date(calcStart.getTime());

    while (day <= end) {
      let net = 0;

      if (day <= today) {
        for (const txn of transactions) {
          if (txn.status !== 'realized' || txn.is_silent === true || txn.is_simulated === true) continue;
          if (!txn.realized_date) continue;
          if (startOfUtcDay(txn.realized_date).getTime() !== day.getTime()) continue;
          net = roundCurrency(net + this.cashEffect(txn, accountsById));
        }
      }

      if (day >= today) {
        for (const txn of transactions) {
          if (txn.status !== 'pending') continue;
          if (txn.is_simulated === true && !includeSimulations) continue;
          const expectedDay = startOfUtcDay(txn.expected_date);
          const eventDay = expectedDay < today ? today : expectedDay;
          if (eventDay.getTime() !== day.getTime()) continue;
          net = roundCurrency(net + this.cashEffect(txn, accountsById));
        }
      }

      for (const event of invoiceEvents) {
        if (event.day.getTime() === day.getTime()) net = roundCurrency(net + event.amount);
      }

      for (const event of recurrenceEvents) {
        if (event.day.getTime() === day.getTime()) net = roundCurrency(net + event.amount);
      }

      // Simulated card purchases never enter a physical invoice; project them
      // once on their invoice due date when simulations are requested.
      if (includeSimulations && day >= today) {
        for (const txn of transactions) {
          if (txn.is_simulated !== true || !txn.card_id || txn.is_silent === true) continue;
          const card = await this.findCard(txn.card_id, cardCache);
          if (!card) continue;
          const purchaseDate = txn.purchase_date || txn.expected_date;
          const dueDay = startOfUtcDay(
            calculateCardDueDate(purchaseDate, card.closing_day, card.due_day)
          );
          const eventDay = this.latestDay(dueDay, today, calcStart);
          if (eventDay.getTime() !== day.getTime()) continue;
          const amount = txn.type === 'expense' ? -roundCurrency(txn.amount) : roundCurrency(txn.amount);
          net = roundCurrency(net + amount);
        }
      }

      balance = roundCurrency(balance + net);
      if (day >= start) {
        timeline.push({ date: dayKey(day), balance });
      }
      day = addUtcDays(day, 1);
    }

    return { timeline, upcomingInvoices };
  }

  private latestDay(first: Date, second: Date, third: Date): Date {
    return new Date(Math.max(first.getTime(), second.getTime(), third.getTime()));
  }

  private async findCard(cardId: string, cache: Map<string, Card | null>): Promise<Card | null> {
    if (cache.has(cardId)) return cache.get(cardId) ?? null;
    const card = await this.cardRepository.findById(cardId);
    cache.set(cardId, card ?? null);
    return card ?? null;
  }

  private effectiveInvoiceStatus(
    invoice: Invoice,
    children: Transaction[],
    card: Card,
    now: Date
  ): 'OPEN' | 'CLOSED' | 'PAID' {
    if (invoice.status === 'PAID') return 'PAID';
    if (children.length > 0 && children.every(child => child.status === 'realized')) return 'PAID';
    const closingDate = calculateClosingDate(invoice.due_date, card.closing_day, card.due_day);
    return now > closingDate ? 'CLOSED' : 'OPEN';
  }

  /**
   * Liquid cash effect of one transaction. Card purchases stay at zero and
   * arrive through their invoice. A transfer moves only its liquid legs, so a
   * transfer into or out of an investment changes liquid cash by one side.
   */
  private cashEffect(txn: Transaction, accountsById: Map<string, Account>): number {
    if (txn.is_silent === true) return 0;
    if (txn.card_id) return 0;

    const amount = roundCurrency(txn.amount);
    if (txn.type === 'transfer') {
      let effect = 0;
      const source = txn.account_id ? accountsById.get(txn.account_id) : undefined;
      const destination = txn.destination_account_id
        ? accountsById.get(txn.destination_account_id)
        : undefined;
      if (source && source.type !== 'investment') effect = roundCurrency(effect - amount);
      if (destination && destination.type !== 'investment') effect = roundCurrency(effect + amount);
      return effect;
    }

    if (!txn.account_id) {
      // Unassigned pending rows move aggregate forecast cash; an unassigned
      // realized row never moved an account, so it contributes nothing.
      return txn.status === 'pending' ? (txn.type === 'income' ? amount : -amount) : 0;
    }

    const account = accountsById.get(txn.account_id);
    if (!account || account.type === 'investment') return 0;
    return txn.type === 'income' ? amount : -amount;
  }
}
