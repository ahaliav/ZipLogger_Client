# Publishing the SDKs

Everything in this repository is packaging-ready and CI-wired. What remains are the account steps
that need a human with the registry logins. Do them once; afterwards every release is a git tag.

Current state at 0.3.3: **every registry is live** (NuGet, npm x2, PyPI, Maven Central, and the Go
proxy), each verified by installing the published package and running it. The accounts below are
already set up, so future releases are a tag and nothing else.

| Registry | Package | Account work needed | Then publishing is |
|---|---|---|---|
| npm | `ziplogger`, `@ziplogger/browser` | create npm account + `ziplogger` org, add `NPM_TOKEN` secret | automatic on tag |
| PyPI | `ziplogger` | create PyPI account, add a Trusted Publisher | automatic on tag, no token stored |
| Maven Central | `dev.ziplogger:ziplogger` | Central account, verify `ziplogger.dev` by DNS, GPG key, 4 secrets | automatic on tag |
| Go module proxy | `github.com/ziploggerhq/ZipLogger_Client/sdk_go` | none, the proxy reads this public repo | tag only |
| NuGet | `ZipLogger.*` | already done | tag in the platform repo |

## 1. npm (fastest, about 5 minutes)

1. Create an account at <https://www.npmjs.com/signup> and enable 2FA.
2. Create the organization `ziplogger` (<https://www.npmjs.com/org/create>, free for public
   packages). This reserves the `@ziplogger/*` scope used by the browser SDK.
3. Create an access token: **Access Tokens → Generate New Token → Granular**, with *Read and write*
   on packages and on the `ziplogger` org. Under **Security settings**, check **Bypass two-factor
   authentication (2FA)**. Without that box every publish fails with a 403 reading "Two-factor
   authentication or granular access token with bypass 2fa enabled is required", after the run has
   already built and signed the package. The box can also be ticked later by editing the token,
   which leaves the token value unchanged, so the GitHub secret does not need updating.
4. In this repository: **Settings → Secrets and variables → Actions → New repository secret**,
   name `NPM_TOKEN`, paste the token.

## 2. PyPI (about 10 minutes, no token to store)

1. Create an account at <https://pypi.org/account/register/> and enable 2FA.
2. Go to <https://pypi.org/manage/account/publishing/> and add a **pending trusted publisher**:
   - PyPI project name: `ziplogger`
   - Owner: `ziploggerhq`
   - Repository: `ZipLogger_Client`
   - Workflow: `publish.yml`
   - Environment: `pypi`
3. In this repository: **Settings → Environments → New environment** named `pypi` (no secrets
   needed; the workflow authenticates with OIDC).

Trusted Publishing is worth the extra step: there is no long-lived API token to leak.

## 3. Maven Central (the long one, about 30 minutes)

1. Register at <https://central.sonatype.com/> (sign in with GitHub is fine).
2. Claim the namespace `dev.ziplogger`: **Namespaces → Add Namespace → dev.ziplogger**. Central
   will show a TXT record to add to the `ziplogger.dev` DNS zone (in Cloudflare: DNS → Records →
   Add record → TXT, name `@`, value as shown). Click Verify once it propagates.
3. Generate a publishing token at <https://central.sonatype.com/usertoken> and click
   **Generate User Token**. A modal shows a username and password pair. Copy both immediately: the
   modal cannot be reopened, and a lost token can only be replaced. These two values are
   `MAVEN_CENTRAL_USERNAME` and `MAVEN_CENTRAL_PASSWORD`, not your login email and password.
4. Create a GPG key for signing (Central rejects unsigned artifacts). Run these in Git Bash, one at
   a time; each pops a pinentry window for the passphrase. The key id is the hex string after
   `rsa4096/` on the `sec` line. Note which half goes where: the **public** key goes to a keyserver
   so Central can check the signatures, the **private** key goes into the GitHub secret so CI can
   produce them.

   ```bash
   gpg --quick-generate-key "Your Name <you@example.com>" rsa4096 sign 2y
   gpg --list-secret-keys --keyid-format=long              # note the key id
   gpg --keyserver keyserver.ubuntu.com --send-keys <KEY_ID>   # public half
   cd ~ && gpg --armor --export-secret-keys <KEY_ID> > private-key.asc   # private half
   cat ~/private-key.asc | clip                           # straight to the clipboard
   ```

   Export the private key somewhere that does not sync: a OneDrive-backed Desktop would upload it.
   Delete `private-key.asc` once the secret is saved; the key stays in `~/.gnupg`.

   **Verify the keyserver upload actually landed.** `--send-keys` exits 0 even when dirmngr could
   not reach the server, and the only symptom is Central rejecting every `.asc` file with "Could not
   find a public key by the key fingerprint" after a full build. A 200 here means Central can see it:

   ```bash
   curl -s -o /dev/null -w "%{http_code}
" "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0x<FULL_FINGERPRINT>"
   ```

5. Add four repository secrets: `MAVEN_CENTRAL_USERNAME`, `MAVEN_CENTRAL_PASSWORD` (from step 3),
   `MAVEN_GPG_KEY` (contents of `private-key.asc`), `MAVEN_GPG_PASSPHRASE`.
6. Delete `private-key.asc` afterwards.

If Maven Central feels like too much for now, skip it: the other four registries are independent,
and the Java SDK can keep being consumed from source.

## 4. Release

Push this repository to GitHub (it must be public for the Go module proxy), then tag:

Tag either the all-in-one `v*` or the per-registry tags, never both for the same version. Both
match the Maven job, so two runs race for the same coordinate and one fails with "currently being
published in another deployment" even though the other is succeeding.

```bash
git tag v0.3.3 && git push origin v0.3.3          # everything
git tag npm-v0.3.3 && git push origin npm-v0.3.3  # npm only
git tag pypi-v0.3.3 && git push origin pypi-v0.3.3
git tag maven-v0.3.3 && git push origin maven-v0.3.3
git tag sdk_go/v0.3.3 && git push origin sdk_go/v0.3.3   # required for `go get @v0.3.3`
```

The Go tag must keep the `sdk_go/` prefix: that is how Go versions a module living in a
subdirectory. Without it, `go get` can still fetch `@latest` from the default branch, but pinned
versions will not resolve.

## 5. Verify after publishing

```bash
pip download ziplogger==0.3.3 -d /tmp/zl --no-deps
npm view ziplogger version && npm view @ziplogger/browser version
GOPROXY=proxy.golang.org go list -m github.com/ziploggerhq/ZipLogger_Client/sdk_go@v0.3.3
curl -s https://repo1.maven.org/maven2/dev/ziplogger/ziplogger/0.3.3/ | head
```

## Release checklist for future versions

1. Bump the version in `sdk_python/pyproject.toml`, `sdk_node/package.json`,
   `sdk_browser/package.json`, `sdk_java/pom.xml` (Go takes its version from the tag).
2. Run the tests: `npm test` in both npm packages, `python -m unittest discover -s tests` in
   `sdk_python`, `go test ./...` in `sdk_go`, `mvn test` in `sdk_java`.
3. Tag `vX.Y.Z` plus `sdk_go/vX.Y.Z` and push.
