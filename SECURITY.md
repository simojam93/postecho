# Security

Please report a vulnerability privately. Don't open a public issue for it. Use **Report a vulnerability**
on the repository's [Security tab](https://github.com/simojam93/postecho/security/advisories/new), GitHub's
private vulnerability reporting.

Please include what you found, how to reproduce it, and the commit you tested. You'll get an answer as soon
as possible, and credit in the fix if you want it.

What postecho protects:

- **One owner per install**, behind one password: the session cookie is encrypted with `SESSION_SECRET`.
- **The agent** authenticates with `AGENT_TOKEN`, and outside feeders with `CAPTURE_TOKEN`.
- **Keys stay on the server.** The owner's API keys, whether in the env or saved in Settings, are never
  sent back to the browser and never logged.
