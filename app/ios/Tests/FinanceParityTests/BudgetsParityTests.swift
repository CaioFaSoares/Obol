import XCTest

final class BudgetsParityTests: XCTestCase {
    func testBudgetAccrual() async {
        await ParityTestSupport.run(.budgets, "budget-accrual")
    }
}
