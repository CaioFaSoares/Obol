import XCTest

final class InvoicesParityTests: XCTestCase {
    func testInvCardPurchaseBoundary() async {
        await ParityTestSupport.run(.invoices, "inv-card-purchase-boundary")
    }

    func testInvYearRollover() async {
        await ParityTestSupport.run(.invoices, "inv-year-rollover")
    }

    func testInvPartialPayment() async {
        await ParityTestSupport.run(.invoices, "inv-partial-payment")
    }

    func testInvFullPayment() async {
        await ParityTestSupport.run(.invoices, "inv-full-payment")
    }

    func testInvSilentPayoff() async {
        await ParityTestSupport.run(.invoices, "inv-silent-payoff")
    }

    func testInvPaymentExceedsDebt() async {
        await ParityTestSupport.run(.invoices, "inv-payment-exceeds-debt")
    }

    func testInvChildDelete() async {
        await ParityTestSupport.run(.invoices, "inv-child-delete")
    }

    func testInvDeleteInvoice() async {
        await ParityTestSupport.run(.invoices, "inv-delete-invoice")
    }

    func testInvProjectionNoDoubleCount() async {
        await ParityTestSupport.run(.invoices, "inv-projection-no-double-count")
    }

    func testInvPaymentAtomicFailure() async {
        await ParityTestSupport.run(.invoices, "inv-payment-atomic-failure")
    }

    func testInvWeeklyCardProjection() async {
        await ParityTestSupport.run(.invoices, "inv-weekly-card-projection")
    }
}
