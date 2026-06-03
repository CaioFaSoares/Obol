import { CardRepository } from '../../../domain/interfaces/CardRepository';
import { AccountRepository } from '../../../domain/interfaces/AccountRepository';
import { InvoiceRepository } from '../../../domain/interfaces/InvoiceRepository';
import { TransactionRepository } from '../../../domain/interfaces/TransactionRepository';
import { NotFoundError, ValidationError } from '../../../domain/errors';
import { sum, sub } from '../../../domain/utils/mathUtils';

interface PayInvoiceInput {
  cardId: string;
  period: string;
  accountId?: string;
  amountPaid?: number;
  ignoreBalance?: boolean;
}

interface PayInvoiceResult {
  success: boolean;
  message: string;
  new_account_balance: number | null;
}

export class PayInvoiceUseCase {
  constructor(
    private readonly cardRepository: CardRepository,
    private readonly accountRepository: AccountRepository,
    private readonly invoiceRepository: InvoiceRepository,
    private readonly transactionRepository: TransactionRepository
  ) {}

  async execute(input: PayInvoiceInput): Promise<PayInvoiceResult> {
    const { cardId, period, accountId, amountPaid, ignoreBalance } = input;

    // 1. Validamos o cartão
    const card = await this.cardRepository.findById(cardId);
    if (!card) {
      throw new NotFoundError('Cartão não encontrado.');
    }

    let account = null;
    if (!ignoreBalance) {
      if (!accountId) {
        throw new ValidationError('account_id é obrigatório quando não é baixa silenciosa.');
      }
      account = await this.accountRepository.findById(accountId);
      if (!account) {
        throw new NotFoundError('Conta não encontrada.');
      }
    }

    // 2. Buscamos a fatura física exata
    const invoice = await this.invoiceRepository.findByPeriodAndCard(cardId, period);
    if (!invoice) {
      throw new NotFoundError('Fatura não encontrada para o período informado.');
    }

    const totalDue = sub(invoice.total_amount, invoice.paid_amount || 0);
    let newBalance: number | null = null;

    // 3. Executa as Mutações
    if (!ignoreBalance) {
      if (!amountPaid || amountPaid <= 0) {
        throw new ValidationError('O valor pago deve ser maior que zero.');
      }
      if (amountPaid > totalDue + 0.01) {
        throw new ValidationError('O valor pago não pode exceder o saldo devedor restante da fatura.');
      }

      // A. Abate o saldo da Conta Corrente
      if (!account) throw new Error('Conta não encontrada ou não informada.');
      newBalance = sub(account.initial_balance, amountPaid);
      await this.accountRepository.update(account.id, { 
        initial_balance: newBalance 
      });

      // B. Registra a saída da conta corrente no histórico
      await this.transactionRepository.create({
        title: `Pagamento Fatura ${card.name} ${period}`,
        amount: amountPaid,
        type: 'expense',
        status: 'realized',
        account_id: account.id,
        realized_date: new Date().toISOString(),
        expected_date: new Date().toISOString()
      });

      // C. Atualiza o paid_amount da Fatura
      const newPaidAmount = sum(invoice.paid_amount || 0, amountPaid);
      const remaining = sub(invoice.total_amount, newPaidAmount);
      const isPartial = remaining > 0.01;

      if (isPartial) {
        await this.invoiceRepository.update(invoice.id, {
          paid_amount: newPaidAmount
        });
        return { 
          success: true, 
          message: `Pagamento parcial de R$ ${amountPaid} registrado com sucesso!`,
          new_account_balance: newBalance
        };
      } else {
        await this.invoiceRepository.update(invoice.id, {
          paid_amount: newPaidAmount,
          status: 'PAID'
        });
      }
    } else {
      // Baixa silenciosa completa a fatura
      await this.invoiceRepository.update(invoice.id, {
        status: 'PAID'
      });
    }

    // D. Quitação Total (Baixa nas transações filhas)
    const txns = await this.transactionRepository.listAll({
      filter: `invoice_id = '${invoice.id}' && status = 'pending'`,
    });
    
    for (const txn of txns) {
      await this.transactionRepository.update(txn.id, {
        status: 'realized',
        realized_date: new Date().toISOString()
      });
    }

    return { 
      success: true, 
      message: ignoreBalance ? `Fatura resolvida silenciosamente!` : `Fatura de ${period} quitada!`,
      new_account_balance: newBalance
    };
  }
}
