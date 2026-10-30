# flutrace-mcp

A local MCP server that lets AI agents read the HTTP traffic of a Flutter app
running in debug mode. It reads requests from the Dart VM Service, so there is
no proxy, certificate, or app change. Part of
[Flutrace](https://github.com/RiccardoCherchi/flutrace).

```sh
claude mcp add flutrace -- npx -y flutrace-mcp
```

If the Flutrace desktop app is connected, the tools attach to the same app
automatically. Otherwise call `connect` with the VM Service URL from
`flutter run`. Requires Node.js 22 or later. The server runs over stdio and only connects to
localhost VM Service URLs. Credentials, cookies, and JWTs are redacted unless
`FLUTRACE_MCP_SHOW_SECRETS=1` is set. `FLUTRACE_VM_URL` sets a default URL for
`connect`.

Tools: `connect`, `status`, `list_requests`, `get_request`, `search`,
`wait_for_request`, `as_curl`, `clear`, `pause`, `resume`, `disconnect`.

MIT © 2026 Riccardo
