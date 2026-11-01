import XCTest

final class ForecastParityTests: XCTestCase {
    func testFcstRollbackAndPending() async {
        await ParityTestSupport.run(.forecast, "fcst-rollback-and-pending")
    }

    func testFcstOverduePending() async {
        await ParityTestSupport.run(.forecast, "fcst-overdue-pending")
    }

    func testFcstInvestmentExclusion() async {
        await ParityTestSupport.run(.forecast, "fcst-investment-exclusion")
    }

    func testFcstUnassignedPending() async {
        await ParityTestSupport.run(.forecast, "fcst-unassigned-pending")
    }

    func testFcstOverdueInvoicePast() async {
        await ParityTestSupport.run(.forecast, "fcst-overdue-invoice-past")
    }

    func testFcstTransferToInvestment() async {
        await ParityTestSupport.run(.forecast, "fcst-transfer-to-investment")
    }

    func testFcstWeeklyOccurrences() async {
        await ParityTestSupport.run(.forecast, "fcst-weekly-occurrences")
    }
}
