import XCTest

final class ProjectsParityTests: XCTestCase {
    func testProjectPaymentLifecycle() async {
        await ParityTestSupport.run(.projects, "project-payment-lifecycle")
    }

    func testProjectPaymentMissing() async {
        await ParityTestSupport.run(.projects, "project-payment-missing")
    }
}
