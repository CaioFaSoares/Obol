import { Recurrence, RecurrenceUpdatePatch, storedRecurrenceFields } from '../../../domain/entities/Recurrence';
import { RecurrenceRepository } from '../../../domain/interfaces/RecurrenceRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { CategoryRepository } from '../../../domain/interfaces/CategoryRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { resolveRecurrenceCadence } from '../../../domain/recurrence/cadence';
import { roundCurrency } from '../../../domain/utils/mathUtils';

/** Empty relation strings from storage mean "no relation". */
function relation(value: string | null | undefined): string | undefined {
  return value ? value : undefined;
}

/**
 * Patch semantics for one clearable text field: an omitted field keeps the
 * stored value, `null` clears it and any other value replaces it.
 */
function patchedText(stored: string | undefined, incoming: string | null | undefined): string | undefined {
  if (incoming === null) return undefined;
  if (incoming === undefined) return relation(stored);
  return relation(incoming);
}

export class UpdateRecurrenceUseCase {
  constructor(
    private readonly recurrenceRepository: RecurrenceRepository,
    private readonly accountRepository: AccountRepository,
    private readonly cardRepository: CardRepository,
    private readonly categoryRepository: CategoryRepository
  ) {}

  async execute(id: string, body: RecurrenceUpdatePatch): Promise<Recurrence> {
    const stored = await this.recurrenceRepository.findById(id);
    if (!stored) {
      throw new NotFoundError('Recurrence was not found.');
    }

    // The final state is stored state plus the patch. Every check below runs
    // against that state, so a cleared or replaced reference is validated in
    // the shape it will be persisted in.
    const final: Recurrence = {
      ...stored,
      name: body.name ?? stored.name,
      amount: body.amount ?? stored.amount,
      payday: body.payday ?? stored.payday,
      type: body.type ?? stored.type,
      frequency: body.frequency === null ? undefined : body.frequency ?? stored.frequency,
      weekday: body.weekday === null ? undefined : body.weekday ?? stored.weekday,
      account_id: patchedText(stored.account_id, body.account_id),
      card_id: patchedText(stored.card_id, body.card_id),
      category_id: patchedText(stored.category_id, body.category_id),
      end_date: patchedText(stored.end_date, body.end_date),
      total_installments:
        body.total_installments === null
          ? undefined
          : body.total_installments ?? (stored.total_installments || undefined),
      skipped_periods:
        body.skipped_periods !== undefined ? [...body.skipped_periods] : stored.skipped_periods
    };

    if (!final.name || !final.name.trim()) {
      throw new ValidationError('Recurrence name cannot be empty.');
    }
    if (!Number.isFinite(final.amount) || final.amount <= 0) {
      throw new ValidationError('Recurrence amount must be greater than zero.');
    }
    if (!Number.isInteger(final.payday) || final.payday < 1 || final.payday > 31) {
      throw new ValidationError('Recurrence payday must be between 1 and 31.');
    }
    if (final.type !== 'income' && final.type !== 'expense') {
      throw new ValidationError('Recurrence type must be an income or an expense.');
    }
    const cadence = resolveRecurrenceCadence(final.frequency, final.weekday);
    if (
      final.total_installments !== undefined &&
      (!Number.isInteger(final.total_installments) || final.total_installments <= 0)
    ) {
      throw new ValidationError('Total installments must be a positive whole number.');
    }
    if (final.end_date !== undefined && !Number.isFinite(Date.parse(final.end_date.replace(' ', 'T')))) {
      throw new ValidationError('Recurrence end date is not a valid date.');
    }
    if (final.account_id && final.card_id) {
      throw new ValidationError('A recurrence cannot use both a bank account and a card.');
    }

    // Status is not patchable: the toggle, launch and expiry paths own it, so
    // an ended recurrence can never be resurrected through an update.

    if (final.account_id) {
      const account = await this.accountRepository.findById(final.account_id);
      if (!account) throw new NotFoundError(`Account ${final.account_id} was not found.`);
    }
    if (final.card_id) {
      const card = await this.cardRepository.findById(final.card_id);
      if (!card) throw new NotFoundError(`Card ${final.card_id} was not found.`);
    }
    if (final.category_id) {
      const category = await this.categoryRepository.findById(final.category_id);
      if (!category) throw new NotFoundError(`Category ${final.category_id} was not found.`);
    }

    if (body.amount !== undefined) {
      final.amount = roundCurrency(final.amount);
    }
    final.frequency = cadence.frequency;
    final.weekday = cadence.weekday;
    return await this.recurrenceRepository.update(id, storedRecurrenceFields(final));
  }
}
