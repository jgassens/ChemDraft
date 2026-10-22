`network-cert.der` and `network-key.der` are a self-signed localhost certificate and its test-only
PKCS#8 RSA key. They are used only by the loopback TLS failure test, never trusted or installed.
Generated offline with OpenSSL (no rcgen or new dev dependency):

```
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -sha256 -days 36500 -nodes -subj /CN=localhost -addext 'basicConstraints=critical,CA:FALSE' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' -addext 'extendedKeyUsage=serverAuth'
openssl x509 -in cert.pem -outform DER -out network-cert.der
openssl pkcs8 -topk8 -nocrypt -in key.pem -outform DER -out network-key.der
```

The PEM intermediates were discarded. The expected failure is UnknownIssuer, regardless of the
certificate's name or date; the client verifies it against its normal roots.
