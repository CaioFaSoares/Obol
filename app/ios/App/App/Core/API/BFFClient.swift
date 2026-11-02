import Foundation

/// JSON-over-HTTPS client for the Obol BFF (D009).
///
/// The client is bound to one normalized ``ServerOrigin`` for its lifetime.
/// It sends credentials only through `Authorization: Bearer`, never persists
/// cookies or cached responses, refuses cross-origin and downgrade redirects
/// through its session delegate, and classifies failures into ``APIError``.
///
/// There is no retry logic here. Auth and financial mutations report the first
/// failure honestly; callers decide whether a retry is safe.
public struct BFFClient: @unchecked Sendable {
    /// Tunable transport limits.
    public struct Configuration: Sendable {
        /// Per-request timeout, seconds.
        public var requestTimeout: TimeInterval
        /// Whole-resource timeout, seconds.
        public var resourceTimeout: TimeInterval
        /// Maximum encoded request body size, bytes.
        public var maximumRequestBytes: Int
        /// Maximum accepted response size, bytes.
        public var maximumResponseBytes: Int
        /// Optional User-Agent header.
        public var userAgent: String?

        public init(
            requestTimeout: TimeInterval = 30,
            resourceTimeout: TimeInterval = 60,
            maximumRequestBytes: Int = 10 * 1024 * 1024,
            maximumResponseBytes: Int = 10 * 1024 * 1024,
            userAgent: String? = nil
        ) {
            self.requestTimeout = requestTimeout
            self.resourceTimeout = resourceTimeout
            self.maximumRequestBytes = maximumRequestBytes
            self.maximumResponseBytes = maximumResponseBytes
            self.userAgent = userAgent
        }
    }

    /// HTTP methods used by the BFF contract.
    public enum Method: String, Sendable {
        case get = "GET"
        case post = "POST"
        case put = "PUT"
        case patch = "PATCH"
        case delete = "DELETE"
    }

    /// A single BFF request.
    ///
    /// `path` must be an absolute path such as `/api/auth/login`; query values
    /// belong in `queryItems`. The Bearer token is only ever placed in the
    /// `Authorization` header.
    public struct Request: Sendable {
        public var method: Method
        public var path: String
        public var queryItems: [URLQueryItem]
        public var body: Data?
        public var bearerToken: String?
        public var headerFields: [String: String]

        public init(
            method: Method,
            path: String,
            queryItems: [URLQueryItem] = [],
            body: Data? = nil,
            bearerToken: String? = nil,
            headerFields: [String: String] = [:]
        ) {
            self.method = method
            self.path = path
            self.queryItems = queryItems
            self.body = body
            self.bearerToken = bearerToken
            self.headerFields = headerFields
        }
    }

    public let origin: ServerOrigin
    public let policy: TransportSecurityPolicy
    public let configuration: Configuration

    private let session: URLSession

    /// Creates a client after validating `origin` against `policy`.
    ///
    /// Throws ``TLSGuardError`` when the origin is insecure or malformed for the
    /// selected policy.
    public init(
        origin: ServerOrigin,
        policy: TransportSecurityPolicy = .secure,
        configuration: Configuration = Configuration()
    ) throws {
        let tlsGuard = TLSGuard(policy: policy)
        try tlsGuard.validate(origin)
        let sessionConfiguration = tlsGuard.makeConfiguration()
        sessionConfiguration.timeoutIntervalForRequest = configuration.requestTimeout
        sessionConfiguration.timeoutIntervalForResource = configuration.resourceTimeout
        let session = try tlsGuard.makeSession(for: origin, configuration: sessionConfiguration)
        self.origin = origin
        self.policy = policy
        self.configuration = configuration
        self.session = session
    }

    /// Creates a client from a user-entered server address.
    ///
    /// The address is normalized by ``TLSGuard``; it must be a bare origin and
    /// must satisfy `policy`.
    public init(
        serverAddress: String,
        policy: TransportSecurityPolicy = .secure,
        configuration: Configuration = Configuration()
    ) throws {
        let origin = try TLSGuard(policy: policy).origin(from: serverAddress)
        try self.init(origin: origin, policy: policy, configuration: configuration)
    }

    /// Cancels outstanding tasks and releases the bound delegate.
    public func invalidateAndCancel() {
        session.invalidateAndCancel()
    }

    // MARK: - Typed requests

    /// Performs a request and decodes a JSON response.
    ///
    /// Throws ``APIError`` for every non-2xx status, redirect, transport
    /// failure, or decoding failure.
    public func perform<Response: Decodable>(_ request: Request) async throws -> Response {
        let data = try await data(for: request)
        guard !data.isEmpty else {
            throw APIError.decodingFailed
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw APIError.decodingFailed
        }
    }

    /// Performs a request that has no response body to decode.
    public func performWithoutResponse(_ request: Request) async throws {
        _ = try await data(for: request)
    }

    public func get<Response: Decodable>(
        _ path: String,
        queryItems: [URLQueryItem] = [],
        bearerToken: String? = nil
    ) async throws -> Response {
        try await perform(
            Request(
                method: .get,
                path: path,
                queryItems: queryItems,
                bearerToken: bearerToken
            )
        )
    }

    public func post<Body: Encodable, Response: Decodable>(
        _ path: String,
        body: Body,
        bearerToken: String? = nil
    ) async throws -> Response {
        try await perform(
            Request(
                method: .post,
                path: path,
                body: try encode(body),
                bearerToken: bearerToken
            )
        )
    }

    public func postWithoutResponse<Body: Encodable>(
        _ path: String,
        body: Body,
        bearerToken: String? = nil
    ) async throws {
        try await performWithoutResponse(
            Request(
                method: .post,
                path: path,
                body: try encode(body),
                bearerToken: bearerToken
            )
        )
    }

    public func delete<Response: Decodable>(
        _ path: String,
        bearerToken: String? = nil
    ) async throws -> Response {
        try await perform(
            Request(method: .delete, path: path, bearerToken: bearerToken)
        )
    }

    public func deleteWithoutResponse(
        _ path: String,
        bearerToken: String? = nil
    ) async throws {
        try await performWithoutResponse(
            Request(
                method: .delete,
                path: path,
                bearerToken: bearerToken
            )
        )
    }

    /// Encodes a JSON request body, translating coder failure into a local
    /// request error.
    public func encode<Body: Encodable>(_ body: Body) throws -> Data {
        do {
            return try JSONEncoder().encode(body)
        } catch {
            throw APIError.invalidRequest("the JSON body could not be encoded")
        }
    }

    // MARK: - Transport

    private func data(for request: Request) async throws -> Data {
        let urlRequest = try makeURLRequest(request)
        do {
            let (data, response) = try await session.data(for: urlRequest)
            return try validate(data: data, response: response)
        } catch let error as APIError {
            throw error
        } catch is CancellationError {
            throw APIError.cancelled
        } catch let urlError as URLError {
            if urlError.code == .cancelled {
                throw APIError.cancelled
            }
            throw APIError.transport(TransportFailure(urlError: urlError))
        } catch {
            throw APIError.transport(.other(0))
        }
    }

    private func makeURLRequest(_ request: Request) throws -> URLRequest {
        let url = try makeURL(path: request.path, queryItems: request.queryItems)
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method.rawValue
        urlRequest.timeoutInterval = configuration.requestTimeout
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        urlRequest.httpShouldHandleCookies = false
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let userAgent = configuration.userAgent, !userAgent.isEmpty {
            urlRequest.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        }
        if let body = request.body {
            guard body.count <= configuration.maximumRequestBytes else {
                throw APIError.requestTooLarge(limit: configuration.maximumRequestBytes)
            }
            urlRequest.httpBody = body
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        for (field, value) in request.headerFields {
            let normalized = field.lowercased()
            guard normalized != "authorization",
                  normalized != "cookie",
                  normalized != "set-cookie" else {
                throw APIError.invalidRequest("the \(field) header is managed by the client")
            }
            urlRequest.setValue(value, forHTTPHeaderField: field)
        }
        if let token = request.bearerToken {
            try Self.validateBearerToken(token)
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return urlRequest
    }

    private func makeURL(path: String, queryItems: [URLQueryItem]) throws -> URL {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else {
            throw APIError.invalidRequest("the path must be absolute on the configured origin")
        }
        let forbidden = CharacterSet(charactersIn: "?#\\")
            .union(.whitespacesAndNewlines)
            .union(.controlCharacters)
        guard path.rangeOfCharacter(from: forbidden) == nil else {
            throw APIError.invalidRequest("the path contains characters that are not allowed")
        }
        guard var components = URLComponents(url: origin.url, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidRequest("the configured origin is not a valid URL")
        }
        components.percentEncodedPath = path
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        guard let url = components.url else {
            throw APIError.invalidRequest("the request URL could not be constructed")
        }
        guard url.scheme?.lowercased() == origin.scheme.rawValue,
              url.host?.lowercased() == origin.host,
              (url.port ?? origin.scheme.defaultPort) == origin.port else {
            throw APIError.invalidRequest("the request URL escaped the configured origin")
        }
        return url
    }

    private func validate(data: Data, response: URLResponse) throws -> Data {
        guard let http = response as? HTTPURLResponse, let responseURL = http.url else {
            throw APIError.invalidResponse
        }
        guard responseURL.scheme?.lowercased() == origin.scheme.rawValue,
              responseURL.host?.lowercased() == origin.host,
              (responseURL.port ?? origin.scheme.defaultPort) == origin.port else {
            throw APIError.invalidResponse
        }
        guard data.count <= configuration.maximumResponseBytes else {
            throw APIError.responseTooLarge(limit: configuration.maximumResponseBytes)
        }
        let status = http.statusCode
        if (200..<300).contains(status) {
            return data
        }
        if (300..<400).contains(status) {
            throw APIError.redirectRejected(status: status)
        }
        let body = try? JSONDecoder().decode(ServerErrorBody.self, from: data)
        throw APIError(
            httpStatus: status,
            body: body,
            retryAfter: Self.retryAfter(from: http)
        )
    }

    private static func validateBearerToken(_ token: String) throws {
        guard !token.isEmpty else {
            throw APIError.invalidRequest("the bearer token is empty")
        }
        guard token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              token.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw APIError.invalidRequest("the bearer token is malformed")
        }
    }

    private static func retryAfter(from response: HTTPURLResponse) -> TimeInterval? {
        guard let raw = response.value(forHTTPHeaderField: "Retry-After")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !raw.isEmpty else {
            return nil
        }
        if let seconds = TimeInterval(raw) {
            return max(0, seconds)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let date = formatter.date(from: raw) {
            return max(0, date.timeIntervalSinceNow)
        }
        return nil
    }
}
