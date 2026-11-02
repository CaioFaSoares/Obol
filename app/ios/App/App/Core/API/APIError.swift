import Foundation

/// Uniform `{ code, message }` error body emitted by the Obol BFF (D009 D3).
public struct ServerErrorBody: Decodable, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

/// Stable error codes the BFF can return. Unknown codes remain readable through
/// ``APIError/serverCode`` being `nil` while the raw body is preserved.
public enum ServerErrorCode: String, CaseIterable, Sendable {
    case unauthenticated = "UNAUTHENTICATED"
    case sessionExpired = "SESSION_EXPIRED"
    case setupRequired = "SETUP_REQUIRED"
    case invalidCredentials = "INVALID_CREDENTIALS"
    case rateLimited = "RATE_LIMITED"
    case forbidden = "FORBIDDEN"
    case invalidSetupToken = "INVALID_SETUP_TOKEN"
    case invalidResetToken = "INVALID_RESET_TOKEN"
    case validationError = "VALIDATION_ERROR"
    case notFound = "NOT_FOUND"
    case internalError = "INTERNAL"
}

/// Transport-level failure classification. No URL, token, or response body is
/// retained; the raw `URLError` code is kept only when it has no dedicated case.
public enum TransportFailure: Equatable, Sendable {
    case offline
    case timedOut
    case cannotConnectToHost
    case cannotFindHost
    case dnsLookupFailed
    case secureConnectionFailed
    case networkConnectionLost
    case cancelled
    case other(Int)

    public init(urlError: URLError) {
        switch urlError.code {
        case .notConnectedToInternet, .internationalRoamingOff, .dataNotAllowed:
            self = .offline
        case .timedOut:
            self = .timedOut
        case .cannotConnectToHost:
            self = .cannotConnectToHost
        case .cannotFindHost:
            self = .cannotFindHost
        case .dnsLookupFailed:
            self = .dnsLookupFailed
        case .secureConnectionFailed,
             .serverCertificateUntrusted,
             .serverCertificateHasBadDate,
             .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid:
            self = .secureConnectionFailed
        case .networkConnectionLost:
            self = .networkConnectionLost
        case .cancelled:
            self = .cancelled
        default:
            self = .other(urlError.code.rawValue)
        }
    }
}

/// Typed failure of an Obol BFF request.
///
/// HTTP status mapping is stable: 400 validation, 401 unauthorized, 403
/// forbidden, 404 not found, 409 conflict, 413 payload too large, 429 rate
/// limited (with `Retry-After` when present), 5xx server failure. Any other
/// non-2xx status is preserved as ``server(status:body:)``. Redirects are never
/// followed and surface as ``redirectRejected(status:)``.
public enum APIError: Error, Equatable, Sendable {
    /// The request could not be constructed locally (bad path, header, token,
    /// or body encoding). No network call was made.
    case invalidRequest(String)
    /// The configured deployment origin violates the transport policy.
    case insecureOrigin(TLSGuardError)
    case unauthorized(ServerErrorBody?)
    case forbidden(ServerErrorBody?)
    case notFound(ServerErrorBody?)
    case conflict(ServerErrorBody?)
    case payloadTooLarge(ServerErrorBody?)
    case rateLimited(ServerErrorBody?, retryAfter: TimeInterval?)
    case validation(ServerErrorBody)
    case server(status: Int, body: ServerErrorBody?)
    case redirectRejected(status: Int)
    case responseTooLarge(limit: Int)
    case requestTooLarge(limit: Int)
    case invalidResponse
    case decodingFailed
    case transport(TransportFailure)
    case cancelled

    /// Maps an HTTP status and optional uniform error body to a typed failure.
    public init(httpStatus: Int, body: ServerErrorBody?, retryAfter: TimeInterval? = nil) {
        switch httpStatus {
        case 400:
            if let body = body {
                self = .validation(body)
            } else {
                self = .server(status: 400, body: nil)
            }
        case 401:
            self = .unauthorized(body)
        case 403:
            self = .forbidden(body)
        case 404:
            self = .notFound(body)
        case 409:
            self = .conflict(body)
        case 413:
            self = .payloadTooLarge(body)
        case 429:
            self = .rateLimited(body, retryAfter: retryAfter)
        case 500...599:
            self = .server(status: httpStatus, body: body)
        default:
            self = .server(status: httpStatus, body: body)
        }
    }

    public var httpStatus: Int? {
        switch self {
        case .unauthorized:
            return 401
        case .forbidden:
            return 403
        case .notFound:
            return 404
        case .conflict:
            return 409
        case .payloadTooLarge:
            return 413
        case .rateLimited:
            return 429
        case .validation:
            return 400
        case .server(let status, _):
            return status
        case .redirectRejected(let status):
            return status
        default:
            return nil
        }
    }

    /// The uniform server body, when one was received and decoded.
    public var serverBody: ServerErrorBody? {
        switch self {
        case .unauthorized(let body),
             .forbidden(let body),
             .notFound(let body),
             .conflict(let body),
             .payloadTooLarge(let body),
             .server(_, let body):
            return body
        case .rateLimited(let body, _):
            return body
        case .validation(let body):
            return body
        default:
            return nil
        }
    }

    /// Parsed code, or `nil` for a non-BFF failure or an unknown code.
    public var serverCode: ServerErrorCode? {
        guard let raw = serverBody?.code else {
            return nil
        }
        return ServerErrorCode(rawValue: raw)
    }

    public var serverMessage: String? {
        serverBody?.message
    }

    /// The stored session is rejected: show authentication and keep local data.
    public var isAuthenticationFailure: Bool {
        if httpStatus == 401 {
            return true
        }
        switch serverCode {
        case .unauthenticated, .sessionExpired:
            return true
        default:
            return false
        }
    }

    /// `SESSION_EXPIRED`: the stored token must be deleted, local data kept.
    public var isSessionExpired: Bool {
        serverCode == .sessionExpired
    }

    /// Alias documenting the client obligation for `SESSION_EXPIRED`.
    public var requiresStoredSessionDeletion: Bool {
        isSessionExpired
    }

    /// `INVALID_CREDENTIALS`: inline login error, no retry storm.
    public var isInvalidCredentials: Bool {
        serverCode == .invalidCredentials
    }

    /// `SETUP_REQUIRED`: the server has no owner yet.
    public var isSetupRequired: Bool {
        serverCode == .setupRequired
    }

    public var isRateLimited: Bool {
        if case .rateLimited = self {
            return true
        }
        return httpStatus == 429
    }

    /// Server-provided backoff hint, seconds, when a 429 carried `Retry-After`.
    public var retryAfter: TimeInterval? {
        if case .rateLimited(_, let retryAfter) = self {
            return retryAfter
        }
        return nil
    }

    /// Safe to retry with backoff. Financial mutations are never retried by
    /// this layer; the caller owns idempotency.
    public var isRetryable: Bool {
        switch self {
        case .rateLimited:
            return true
        case .server(let status, _):
            return (500...599).contains(status)
        case .transport(let failure):
            return failure != .cancelled
        default:
            return false
        }
    }
}

extension APIError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .invalidRequest(let detail):
            return "The request is invalid: \(detail)."
        case .insecureOrigin(let error):
            return error.localizedDescription
        case .unauthorized(let body):
            return body?.message ?? "Authentication required."
        case .forbidden(let body):
            return body?.message ?? "The request was refused."
        case .notFound(let body):
            return body?.message ?? "The requested resource was not found."
        case .conflict(let body):
            return body?.message ?? "The server reported a conflict."
        case .payloadTooLarge(let body):
            return body?.message ?? "The request payload is too large."
        case .rateLimited(let body, let retryAfter):
            if let body = body {
                return body.message
            }
            if let retryAfter = retryAfter {
                return "Too many attempts. Retry in \(Int(retryAfter.rounded(.up))) seconds."
            }
            return "Too many attempts. Try again later."
        case .validation(let body):
            return body.message
        case .server(let status, let body):
            return body?.message ?? "The server returned HTTP \(status)."
        case .redirectRejected(let status):
            return "The server attempted a cross-origin or insecure redirect (HTTP \(status)); it was refused."
        case .responseTooLarge(let limit):
            return "The server response exceeded the \(limit)-byte limit."
        case .requestTooLarge(let limit):
            return "The request body exceeded the \(limit)-byte limit."
        case .invalidResponse:
            return "The server returned an unexpected response."
        case .decodingFailed:
            return "The server response could not be decoded."
        case .transport(let failure):
            switch failure {
            case .offline:
                return "The device is offline."
            case .timedOut:
                return "The request timed out."
            case .cannotConnectToHost:
                return "The server could not be reached."
            case .cannotFindHost:
                return "The server host could not be found."
            case .dnsLookupFailed:
                return "The server address could not be resolved."
            case .secureConnectionFailed:
                return "The secure connection to the server failed."
            case .networkConnectionLost:
                return "The network connection was lost."
            case .cancelled:
                return "The request was cancelled."
            case .other:
                return "The network request failed."
            }
        case .cancelled:
            return "The request was cancelled."
        }
    }
}
