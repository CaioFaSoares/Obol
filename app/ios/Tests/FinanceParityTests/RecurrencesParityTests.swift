import XCTest

final class RecurrencesParityTests: XCTestCase {
    func testRecPaydayClampFebruary() async {
        await ParityTestSupport.run(.recurrences, "rec-payday-clamp-february")
    }

    func testRecMonthIdempotency() async {
        await ParityTestSupport.run(.recurrences, "rec-month-idempotency")
    }

    func testRecPauseResume() async {
        await ParityTestSupport.run(.recurrences, "rec-pause-resume")
    }

    func testRecEndDateExpiry() async {
        await ParityTestSupport.run(.recurrences, "rec-end-date-expiry")
    }

    func testRecFiniteInstallments() async {
        await ParityTestSupport.run(.recurrences, "rec-finite-installments")
    }

    func testRecLaunchNextMonth() async {
        await ParityTestSupport.run(.recurrences, "rec-launch-next-month")
    }

    func testRecLaunchCardInvoice() async {
        await ParityTestSupport.run(.recurrences, "rec-launch-card-invoice")
    }

    func testRecSkippedPeriod() async {
        await ParityTestSupport.run(.recurrences, "rec-skipped-period")
    }

    func testRecDeletedChildSkips() async {
        await ParityTestSupport.run(.recurrences, "rec-deleted-child-skips")
    }

    func testRecEndedLaunchError() async {
        await ParityTestSupport.run(.recurrences, "rec-ended-launch-error")
    }

    func testRecInvalidAccountAndCard() async {
        await ParityTestSupport.run(.recurrences, "rec-invalid-account-and-card")
    }

    func testRecWeeklyCurrentWeek() async {
        await ParityTestSupport.run(.recurrences, "rec-weekly-current-week")
    }

    func testRecWeeklySameWeekIdempotent() async {
        await ParityTestSupport.run(.recurrences, "rec-weekly-same-week-idempotent")
    }

    func testRecWeeklySkipKey() async {
        await ParityTestSupport.run(.recurrences, "rec-weekly-skip-key")
    }

    func testRecWeeklyLaunchNextWeek() async {
        await ParityTestSupport.run(.recurrences, "rec-weekly-launch-next-week")
    }

    func testRecWeeklyInstallments() async {
        await ParityTestSupport.run(.recurrences, "rec-weekly-installments")
    }

    func testRecWeeklyWeekCrossesMonth() async {
        await ParityTestSupport.run(.recurrences, "rec-weekly-week-crosses-month")
    }
}
