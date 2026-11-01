import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

/// Resigns the current first responder without owning focus state.
///
/// SwiftUI forms do not always dismiss the keyboard when the user taps the
/// background or scrolls, so a keyboard toolbar exposes an explicit way out.
@MainActor
func dismissKeyboard() {
    #if canImport(UIKit)
    UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder),
        to: nil,
        from: nil,
        for: nil
    )
    #endif
}

extension View {
    /// Adds a keyboard accessory toolbar with a single `Done` action that
    /// resigns first responder.
    @MainActor
    func keyboardDoneToolbar() -> some View {
        toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { dismissKeyboard() }
            }
        }
    }
}
