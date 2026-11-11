# Localhost browser test certificate

`localhost-test.crt` and `localhost-test.key` are deliberately public, synthetic fixtures for `session-cookie.browser.mjs` on ephemeral loopback HTTPS ports only. Never deploy or trust this private key/certificate for any real service. Browser contexts ignore HTTPS certificate errors only in this local test. Production vault HTTPS verification is unchanged.
