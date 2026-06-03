import { Transaction } from '../../../domain/entities/Transaction';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { SyncInvoiceUseCase } from '../invoices/SyncInvoiceUseCase';
import { sum, sub } from '../../../domain/utils/mathUtils';

export class CreateTransactionUseCase {
  constructor(
    private readonly transactionRepository: TransactionRepository,
    private readonly accountRepository: AccountRepository,
    private readonly syncInvoiceUseCase: SyncInvoiceUseCase
  ) {}

  async execute(body: Partial<Transaction>): Promise<Transaction> {
    const data = { ...body };

    // ---------------------------------------------------------
    // REGRA 1: CONTA BANCÁRIA (Pix/Débito) + REALIZADO
    // ---------------------------------------------------------
    if (data.account_id && data.status === 'realized') {
      // 1. Busca a conta atual
      const account = await this.accountRepository.findById(data.account_id);
      
      // 2. Calcula o novo saldo
      let newBalance = account.initial_balance;
      if (data.type === 'income') newBalance = sum(newBalance, data.amount!);
      if (data.type === 'expense') newBalance = sub(newBalance, data.amount!);
      
      // 3. Atualiza o saldo no banco
      await this.accountRepository.update(data.account_id, { 
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
      const purchaseDate = data.expected_date!;
      const invoice = await this.syncInvoiceUseCase.execute(data.card_id, purchaseDate, data.amount!, data.type!);
      
      data.invoice_id = invoice.id;
      data.purchase_date = purchaseDate;
      data.expected_date = invoice.due_date; // Move a cobrança para a data de vencimento da fatura
      data.status = 'pending'; // Gastos de cartão SEMPRE nascem pendentes
    }

    // ---------------------------------------------------------
    // REGRA 3: TRANSFERÊNCIA ENTRE CONTAS
    // ---------------------------------------------------------
    if (data.type === 'transfer' && data.account_id && data.destination_account_id && data.status === 'realized') {
      const sourceAcc = await this.accountRepository.findById(data.account_id);
      const destAcc = await this.accountRepository.findById(data.destination_account_id);
      
      const newSourceBalance = sub(sourceAcc.initial_balance, data.amount!);
      const newDestBalance = sum(destAcc.initial_balance, data.amount!);
      
      await this.accountRepository.update(sourceAcc.id, { initial_balance: newSourceBalance });
      await this.accountRepository.update(destAcc.id, { initial_balance: newDestBalance });
      
      data.category_id = undefined;
      data.card_id = undefined;
      if (!data.realized_date) data.realized_date = new Date().toISOString();
    }

    if (data.status === 'realized') {
      data.is_scheduled = false;
    }

    // Salva a transação final (seja da Regra 1, 2, 3 ou puras)
    return await this.transactionRepository.create(data);
  }
}
