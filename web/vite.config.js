import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// host: true exposes the dev server on the local network, so a phone on the same Wi-Fi can open it.
// The phone only allows the microphone over https, so a self-signed cert in .cert/ turns it on:
//   openssl req -x509 -newkey rsa:2048 -nodes -days 825 -keyout .cert/key.pem -out .cert/cert.pem \
//     -subj "/CN=mixpult" -addext "subjectAltName=DNS:localhost,IP:<your LAN IP>"
const https = existsSync('.cert/key.pem')
  ? { key: readFileSync('.cert/key.pem'), cert: readFileSync('.cert/cert.pem') }
  : undefined;

export default defineConfig({
  server: { host: true, port: 5317, https },
  preview: { host: true, port: 5317, https },
});
