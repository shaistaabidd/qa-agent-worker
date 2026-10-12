import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCredential } from '../src/credential.js'

test('parses JSON with email', () => {
  assert.deepEqual(parseCredential('{"email": "a@b.co", "password": "pw"}'), { login: 'a@b.co', password: 'pw' })
})

test('accepts username in place of email', () => {
  assert.deepEqual(parseCredential('{"username": "admin", "password": "pw"}'), { login: 'admin', password: 'pw' })
})

test('parses login:password, keeping colons in the password', () => {
  assert.deepEqual(parseCredential('a@b.co:p:w'), { login: 'a@b.co', password: 'p:w' })
})

test('rejects anything else', () => {
  assert.throws(() => parseCredential('just-a-password'), /Credential must be JSON/)
})
