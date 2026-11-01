import XCTest

enum ParityTestSupport {
    static func run(
        _ file: FixtureFileID,
        _ caseID: String,
        testFile: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await FixtureRunner.run(file: file, caseID: caseID)
        } catch {
            XCTFail("\(error)", file: testFile, line: line)
        }
    }
}
