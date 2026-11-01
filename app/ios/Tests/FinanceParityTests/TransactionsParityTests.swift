import XCTest

final class TransactionsParityTests: XCTestCase {
    func testTxnRealizeOrdinary() async {
        await ParityTestSupport.run(.transactions, "txn-realize-ordinary")
    }

    func testTxnRealizeSilent() async {
        await ParityTestSupport.run(.transactions, "txn-realize-silent")
    }

    func testTxnRealizeAlreadyRealized() async {
        await ParityTestSupport.run(.transactions, "txn-realize-already-realized")
    }

    func testTxnRealizeSimulated() async {
        await ParityTestSupport.run(.transactions, "txn-realize-simulated")
    }

    func testTxnCreateRealizedSimulation() async {
        await ParityTestSupport.run(.transactions, "txn-create-realized-simulation")
    }

    func testTxnConvertSimulation() async {
        await ParityTestSupport.run(.transactions, "txn-convert-simulation")
    }

    func testTxnMoneyHalfCent() async {
        await ParityTestSupport.run(.transactions, "txn-money-half-cent")
    }

    func testTxnCreateHalfCentCash() async {
        await ParityTestSupport.run(.transactions, "txn-create-half-cent-cash")
    }

    func testTxnEditRealized() async {
        await ParityTestSupport.run(.transactions, "txn-edit-realized")
    }

    func testTxnDeleteRealized() async {
        await ParityTestSupport.run(.transactions, "txn-delete-realized")
    }

    func testTxnTransferNeutral() async {
        await ParityTestSupport.run(.transactions, "txn-transfer-neutral")
    }

    func testTxnTransferAtomicFailure() async {
        await ParityTestSupport.run(.transactions, "txn-transfer-atomic-failure")
    }

    func testTxnEffectiveAtOffline() async {
        await ParityTestSupport.run(.transactions, "txn-effective-at-offline")
    }

    func testTxnMidnightBoundary() async {
        await ParityTestSupport.run(.transactions, "txn-midnight-boundary")
    }

    func testTxnInvalidSameAccount() async {
        await ParityTestSupport.run(.transactions, "txn-invalid-same-account")
    }

    func testTxnInvalidMissingAccount() async {
        await ParityTestSupport.run(.transactions, "txn-invalid-missing-account")
    }
}
