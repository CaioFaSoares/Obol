import Foundation

/// Transport security policy for one remote Obol deployment.
///
/// Cleartext HTTP is refused unless the caller explicitly opts in *and* the
/// process was compiled with `DEBUG`. Release builds always evaluate the
/// policy as secure, so no shipped binary can be switched to plaintext by
/// configuration alone. There is no app-wide ATS or trust exception here.
public struct TransportSecurityPolicy: Equatable, Sendable {
    /// Whether the caller asked for cleartext HTTP. Honoured only in DEBUG.
    public let allowsCleartextHTTP: Bool

    public init(allowsCleartextHTTP: Bool) {
        self.allowsCleartextHTTP = allowsCleartextHTTP
    }

    /// HTTPS only.
    public static let secure = TransportSecurityPolicy(allowsCleartextHTTP: false)

    #if DEBUG
    /// Explicit development opt-in. Still refuses cleartext in release builds.
    public static let development = TransportSecurityPolicy(allowsCleartextHTTP: true)
    #endif

    /// Cleartext is permitted only when both the policy and the build allow it.
    var effectiveAllowsCleartextHTTP: Bool {
        #if DEBUG
        return allowsCleartextHTTP
        #else
        return false
        #endif
    }
}

/// Scheme of a normalized server origin.
public enum OriginScheme: String, CaseIterable, Sendable {
    case https
    case http

    /// Port assumed when the authority omits one.
    public var defaultPort: Int {
        switch self {
        case .https:
            return 443
        case .http:
            return 80
        }
    }
}

/// A normalized, credential-safe server origin.
///
/// Instances are only produced by ``TLSGuard``. An origin carries no path,
/// query, fragment, or userinfo, so it can be used to scope stored credentials
/// without ambiguity.
public struct ServerOrigin: Hashable, Sendable, CustomStringConvertible {
    public let scheme: OriginScheme
    /// Lowercased host, without a trailing dot. IPv6 literals keep their
    /// unbracketed form (the URL representation adds the brackets).
    public let host: String
    /// Effective port, always materialized (443/80 when omitted).
    public let port: Int
    /// Canonical origin URL without a path.
    public let url: URL

    init(scheme: OriginScheme, host: String, port: Int, url: URL) {
        self.scheme = scheme
        self.host = host
        self.port = port
        self.url = url
    }

    public var isSecure: Bool {
        scheme == .https
    }

    /// Stable key used to scope Keychain items and sync state per deployment.
    /// Default ports are omitted so `https://host` and `https://host:443`
    /// address the same deployment.
    public var storageKey: String {
        let formattedHost = host.contains(":") ? "[\(host)]" : host
        if port == scheme.defaultPort {
            return "\(scheme.rawValue)://\(formattedHost)"
        }
        return "\(scheme.rawValue)://\(formattedHost):\(port)"
    }

    public var description: String {
        storageKey
    }

    public static func == (lhs: ServerOrigin, rhs: ServerOrigin) -> Bool {
        lhs.scheme == rhs.scheme && lhs.host == rhs.host && lhs.port == rhs.port
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(scheme)
        hasher.combine(host)
        hasher.combine(port)
    }
}

/// Reasons an origin or redirect is refused.
public enum TLSGuardError: Error, Equatable, Sendable {
    case malformedURL
    case missingScheme
    case unsupportedScheme(String)
    case userinfoNotAllowed
    case queryOrFragmentNotAllowed
    case missingHost
    case malformedHost
    case invalidPort
    case unexpectedPath(String)
    case cleartextNotAllowed
}

extension TLSGuardError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .malformedURL:
            return "The server address is not a valid absolute URL."
        case .missingScheme:
            return "The server address must include an https:// scheme."
        case .unsupportedScheme(let scheme):
            return "The scheme \(scheme) is not supported; use https://."
        case .userinfoNotAllowed:
            return "The server address must not contain credentials."
        case .queryOrFragmentNotAllowed:
            return "The server address must be a bare origin without a query or fragment."
        case .missingHost:
            return "The server address is missing a host."
        case .malformedHost:
            return "The server host is not a supported DNS name or IP address."
        case .invalidPort:
            return "The server port is outside the valid range."
        case .unexpectedPath(let path):
            return "The server address must not contain a path (\(path))."
        case .cleartextNotAllowed:
            return "Cleartext HTTP is not allowed. Use HTTPS or the explicit development override in a DEBUG build."
        }
    }
}

/// Normalization, origin binding, and URLSession hardening for remote Obol
/// deployments (D009 D6, D016 D14).
///
/// Responsibilities:
/// - normalize an origin and reject userinfo, query, fragment, unsupported
///   schemes, malformed authorities, and cleartext unless explicitly allowed;
/// - build URLSession configurations that never persist cookies or cached
///   responses for Bearer transport;
/// - bind each URLSession to one origin and block cross-origin or downgrade
///   redirects before credentials can be forwarded;
/// - never accept an arbitrary server certificate: server-trust challenges are
///   handed to the system evaluator, and non-server-trust challenges are
///   cancelled.
public struct TLSGuard: Sendable {
    public let policy: TransportSecurityPolicy

    public init(policy: TransportSecurityPolicy = .secure) {
        self.policy = policy
    }

    /// Parses a user-supplied server address into a normalized origin.
    public func origin(from raw: String) throws -> ServerOrigin {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed) else {
            throw TLSGuardError.malformedURL
        }
        return try origin(from: url)
    }

    /// Normalizes an absolute URL into a credential-safe origin.
    public func origin(from url: URL) throws -> ServerOrigin {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw TLSGuardError.malformedURL
        }
        guard let rawScheme = components.scheme?.lowercased(), !rawScheme.isEmpty else {
            throw TLSGuardError.missingScheme
        }
        guard let scheme = OriginScheme(rawValue: rawScheme) else {
            throw TLSGuardError.unsupportedScheme(rawScheme)
        }
        if components.user != nil || components.password != nil {
            throw TLSGuardError.userinfoNotAllowed
        }
        if components.query != nil || components.fragment != nil {
            throw TLSGuardError.queryOrFragmentNotAllowed
        }
        // URLComponents collapses an out-of-range or empty port to `nil`.
        // Validate the textual authority so a malformed port is refused rather
        // than silently treated as the scheme default.
        try Self.validateExplicitPort(in: url.absoluteString)
        let encodedPath = components.percentEncodedPath
        guard encodedPath.isEmpty || encodedPath == "/" else {
            throw TLSGuardError.unexpectedPath(encodedPath)
        }
        guard var host = components.host, !host.isEmpty else {
            throw TLSGuardError.missingHost
        }
        host = host.lowercased()
        while host.hasSuffix(".") {
            host.removeLast()
        }
        guard !host.isEmpty else {
            throw TLSGuardError.missingHost
        }
        // Only ASCII DNS names and IP literals are accepted. Percent-encoded
        // hosts, zone identifiers, wildcards, and spaces are refused.
        guard host.unicodeScalars.allSatisfy({ $0.isASCII }) else {
            throw TLSGuardError.malformedHost
        }
        guard host.unicodeScalars.allSatisfy({ Self.allowedHostScalars.contains($0) }) else {
            throw TLSGuardError.malformedHost
        }

        let port: Int
        if let explicitPort = components.port {
            guard (1...65535).contains(explicitPort) else {
                throw TLSGuardError.invalidPort
            }
            port = explicitPort
        } else {
            port = scheme.defaultPort
        }

        if scheme == .http && !policy.effectiveAllowsCleartextHTTP {
            throw TLSGuardError.cleartextNotAllowed
        }

        var canonical = URLComponents()
        canonical.scheme = scheme.rawValue
        canonical.host = host
        canonical.port = port == scheme.defaultPort ? nil : port
        guard let canonicalURL = canonical.url else {
            throw TLSGuardError.malformedURL
        }
        return ServerOrigin(scheme: scheme, host: host, port: port, url: canonicalURL)
    }

    /// Revalidates an origin under this guard's policy. A secure guard refuses
    /// an origin that was created for a cleartext development server.
    public func validate(_ origin: ServerOrigin) throws {
        let reparsed = try self.origin(from: origin.url)
        guard reparsed == origin else {
            throw TLSGuardError.malformedURL
        }
    }

    /// A redirect is followed only when its target has exactly the bound
    /// origin's scheme, host, and effective port. A path or query on the target
    /// is fine (redirects normally carry one); a cross-origin hop, userinfo, or
    /// an HTTPS-to-HTTP downgrade never matches, so credentials are never
    /// forwarded elsewhere.
    public func allowsRedirect(from origin: ServerOrigin, to target: URL) -> Bool {
        guard let components = URLComponents(url: target, resolvingAgainstBaseURL: false),
              let rawScheme = components.scheme?.lowercased(),
              let scheme = OriginScheme(rawValue: rawScheme),
              components.user == nil,
              components.password == nil,
              var host = components.host?.lowercased(),
              !host.isEmpty else {
            return false
        }
        while host.hasSuffix(".") {
            host.removeLast()
        }
        let port = components.port ?? scheme.defaultPort
        guard (1...65535).contains(port) else {
            return false
        }
        if scheme == .http && !policy.effectiveAllowsCleartextHTTP {
            return false
        }
        return scheme == origin.scheme && host == origin.host && port == origin.port
    }

    /// URLSession configuration for Bearer-authenticated JSON traffic.
    ///
    /// No cookie storage, no response cache, no connectivity waiting, and TLS
    /// 1.2 as the floor. This is per-session hardening; it does not weaken or
    /// replace app transport security.
    public func makeConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 60
        configuration.waitsForConnectivity = false
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.tlsMaximumSupportedProtocolVersion = .TLSv13
        return configuration
    }

    /// Creates a URLSession bound to `origin` with the guard's redirect and
    /// authentication-challenge handler installed.
    public func makeSession(
        for origin: ServerOrigin,
        configuration: URLSessionConfiguration
    ) throws -> URLSession {
        try validate(origin)
        let delegate = OriginBoundSessionDelegate(origin: origin, tlsGuard: self)
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    public func makeSession(for origin: ServerOrigin) throws -> URLSession {
        try makeSession(for: origin, configuration: makeConfiguration())
    }

    private static func validateExplicitPort(in absoluteString: String) throws {
        guard let schemeSeparator = absoluteString.range(of: "://") else {
            return
        }
        let remainder = absoluteString[schemeSeparator.upperBound...]
        let authority = remainder.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        if authority.hasPrefix("[") {
            guard let closingBracket = authority.firstIndex(of: "]") else {
                throw TLSGuardError.malformedHost
            }
            let tail = authority[authority.index(after: closingBracket)...]
            if tail.isEmpty {
                return
            }
            guard tail.hasPrefix(":") else {
                throw TLSGuardError.malformedHost
            }
            try validatePortText(tail.dropFirst())
            return
        }
        let segments = authority.split(separator: ":", omittingEmptySubsequences: false)
        if segments.count == 1 {
            return
        }
        guard segments.count == 2 else {
            throw TLSGuardError.malformedHost
        }
        try validatePortText(segments[1])
    }

    private static func validatePortText(_ text: Substring) throws {
        guard !text.isEmpty,
              text.allSatisfy({ $0.isASCII && $0.isNumber }),
              let port = Int(text),
              (1...65535).contains(port) else {
            throw TLSGuardError.invalidPort
        }
    }

    private static let allowedHostScalars: CharacterSet = {
        CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789.-_:")
    }()
}

/// URLSession delegate that pins every task to one origin.
///
/// The session retains this delegate until invalidated. Redirects are refused
/// by returning `nil` from the delegate; the original 3xx response then reaches
/// the client, which maps it to ``APIError/redirectRejected(status:)``.
final class OriginBoundSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let origin: ServerOrigin
    private let tlsGuard: TLSGuard

    init(origin: ServerOrigin, tlsGuard: TLSGuard) {
        self.origin = origin
        self.tlsGuard = tlsGuard
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let target = request.url, tlsGuard.allowsRedirect(from: origin, to: target) else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            // No client certificates, basic auth, digest, or NTLM: a challenge
            // outside server trust must not cause credentials to be sent.
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        // System trust evaluation only. No pinned or custom anchor is ever
        // installed here, so an arbitrary certificate is never accepted.
        completionHandler(.performDefaultHandling, nil)
    }
}
