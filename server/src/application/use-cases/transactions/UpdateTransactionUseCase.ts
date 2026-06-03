import { Transaction } from '../../../domain/entities/Transaction';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { NotFoundError } from '../../../domain/errors';
import { sum, sub } from '../../../domain/utils/mathUtils';

export class UpdateTransactionUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase
  ) {}

  async execute(id: string, body: Partial<Transaction>): Promise<Transaction> {
    const oldTxn = await this.transactionRepository.findById(id);
    if (!oldTxn) {
      throw new NotFoundError('Transação não encontrada');
    }

    const data = { ...body };

    // Estorno original se era conta e realizada
    if (oldTxn.account_id && oldTxn.status === 'realized') {
      if (oldTxn.type === 'transfer' && oldTxn.destination_account_id) {
        const sourceAcc = await this.accountRepository.findById(oldTxn.account_id);
        const destAcc = await this.accountRepository.findById(oldTxn.destination_account_id);
        await this.accountRepository.update(sourceAcc.id, { initial_balance: sum(sourceAcc.initial_balance, oldTxn.amount) });
        await this.accountRepository.update(destAcc.id, { initial_balance: sub(destAcc.initial_balance, oldTxn.amount) });
      } else {
        const account = await this.accountRepository.findById(oldTxn.account_id);
        let revertedBalance = account.initial_balance;
        if (oldTxn.type === 'income') revertedBalance = sub(revertedBalance, oldTxn.amount);
        if (oldTxn.type === 'expense') revertedBalance = sum(revertedBalance, oldTxn.amount);
        await this.accountRepository.update(oldTxn.account_id, { initial_balance: revertedBalance });
      }
    }

    // ---------------------------------------------------------
    // APLICA NOVA REGRA 1: CONTA BANCÁRIA + REALIZADO
    // ---------------------------------------------------------
    if (data.account_id && data.status === 'realized') {
      const account = await this.accountRepository.findById(data.account_id);
      let newBalance = account.initial_balance;
      const finalType = data.type || oldTxn.type;
      const finalAmount = data.amount !== undefined ? data.amount : oldTxn.amount;
      if (finalType === 'income') newBalance = sum(newBalance, finalAmount);
      if (finalType === 'expense') newBalance = sub(newBalance, finalAmount);
      
      await this.accountRepository.update(data.account_id, { initial_balance: newBalance });
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
          const oldInvoice = await this.invoiceRepository.findById(oldTxn.invoice_id);
          const oldAmountDelta = oldTxn.type === 'expense' ? -oldTxn.amount : oldTxn.amount;
          await this.invoiceRepository.update(oldInvoice.id, {
            total_amount: sum(oldInvoice.total_amount, oldAmountDelta)
          });
        } catch (e) {
          console.error("Erro no estorno de fatura:", e);
        }
        
        if (!data.card_id) {
          data.invoice_id = undefined;
          data.purchase_date = undefined;
        }
      }
    }

    // ---------------------------------------------------------
    // APLICA NOVA REGRA 2: CARTÃO DE CRÉDITO
    // ---------------------------------------------------------
    if (data.card_id) {
      // Associa e soma à nova fatura (apenas se mudou algo ou se é novo)
      const changedCard = data.card_id !== undefined && data.card_id !== oldTxn.card_id;
      const changedAmountOrType = (data.amount !== undefined && data.amount !== oldTxn.amount) || (data.type !== undefined && data.type !== oldTxn.type);
      const changedDate = data.expected_date !== undefined && data.expected_date !== oldTxn.expected_date;

      if (changedCard || changedAmountOrType || changedDate || !oldTxn.card_id) {
        const baseDate = data.expected_date || oldTxn.purchase_date || oldTxn.expected_date;
        const newAmount = data.amount !== undefined ? data.amount : oldTxn.amount;
        const newType = data.type || oldTxn.type;
        
        const invoice = await this.syncInvoiceUseCase.execute(data.card_id, baseDate, newAmount, newType);
        
        data.invoice_id = invoice.id;
        data.purchase_date = baseDate;
        data.expected_date = invoice.due_date;
        data.status = 'pending'; 
      }
    }

    // ---------------------------------------------------------
    // APLICA NOVA REGRA 3: TRANSFERÊNCIA
    // ---------------------------------------------------------
    if (
      (data.type === 'transfer' || (!data.type && oldTxn.type === 'transfer')) &&
      (data.account_id || oldTxn.account_id) &&
      (data.destination_account_id || oldTxn.destination_account_id) &&
      (data.status === 'realized' || (!data.status && oldTxn.status === 'realized'))
    ) {
      const finalAccountId = data.account_id || oldTxn.account_id;
      const finalDestAccountId = data.destination_account_id || oldTxn.destination_account_id;
      const finalAmount = data.amount !== undefined ? data.amount : oldTxn.amount;

      if (finalAccountId && finalDestAccountId) {
        const sourceAcc = await this.accountRepository.findById(finalAccountId);
        const destAcc = await this.accountRepository.findById(finalDestAccountId);
        
        await this.accountRepository.update(sourceAcc.id, { initial_balance: sub(sourceAcc.initial_balance, finalAmount) });
        await this.accountRepository.update(destAcc.id, { initial_balance: sum(destAcc.initial_balance, finalAmount) });
        
        data.category_id = undefined;
        data.card_id = undefined;
        if (!data.realized_date) data.realized_date = new Date().toISOString();
      }
    }

    if (data.status === 'realized') {
      data.is_scheduled = false;
    }

    return await this.transactionRepository.update(id, data);
  }
}
