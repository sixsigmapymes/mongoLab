import crypto = require('crypto');
import { Binary } from '../../bson';
import { MongoError } from '../../error';
import { AuthProvider, AuthContext } from './auth_provider';
import type { Callback, UniversalError, Document } from '../../types';
import type { MongoCredentials } from './mongo_credentials';
import type { HandshakeDocument } from '../connect';

type CryptoMethod = 'sha1' | 'sha256';

interface SaslPrepModule {
  (password: string): string;
}

let saslprep: SaslPrepModule | null;
try {
  saslprep = require('saslprep');
} catch (e) {
  // don't do anything;
}

class ScramSHA extends AuthProvider {
  cryptoMethod: CryptoMethod;
  constructor(cryptoMethod: CryptoMethod) {
    super();
    this.cryptoMethod = cryptoMethod || 'sha1';
  }

  prepare(handshakeDoc: HandshakeDocument, authContext: AuthContext, callback: Callback) {
    const cryptoMethod = this.cryptoMethod;
    if (cryptoMethod === 'sha256' && saslprep == null) {
      console.warn('Warning: no saslprep library specified. Passwords will not be sanitized');
    }

    crypto.randomBytes(24, (err, nonce) => {
      if (err) {
        return callback(err);
      }

      // store the nonce for later use
      Object.assign(authContext, { nonce });

      const credentials = authContext.credentials;
      const request = Object.assign({}, handshakeDoc, {
        speculativeAuthenticate: Object.assign(makeFirstMessage(cryptoMethod, credentials, nonce), {
          db: credentials.source
        })
      });

      callback(undefined, request);
    });
  }

  auth(authContext: AuthContext, callback: Callback) {
    const response = authContext.response;
    if (response && response.speculativeAuthenticate) {
      continueScramConversation(
        this.cryptoMethod,
        response.speculativeAuthenticate,
        authContext,
        callback
      );

      return;
    }

    executeScram(this.cryptoMethod, authContext, callback);
  }
}

function cleanUsername(username: string) {
  return username.replace('=', '=3D').replace(',', '=2C');
}

function clientFirstMessageBare(username: string, nonce: Buffer) {
  // NOTE: This is done b/c Javascript uses UTF-16, but the server is hashing in UTF-8.
  // Since the username is not sasl-prep-d, we need to do this here.
  return Buffer.concat([
    Buffer.from('n=', 'utf8'),
    Buffer.from(username, 'utf8'),
    Buffer.from(',r=', 'utf8'),
    Buffer.from(nonce.toString('base64'), 'utf8')
  ]);
}

function makeFirstMessage(
  cryptoMethod: CryptoMethod,
  credentials: MongoCredentials,
  nonce: Buffer
) {
  const username = cleanUsername(credentials.username);
  const mechanism = cryptoMethod === 'sha1' ? 'SCRAM-SHA-1' : 'SCRAM-SHA-256';

  // NOTE: This is done b/c Javascript uses UTF-16, but the server is hashing in UTF-8.
  // Since the username is not sasl-prep-d, we need to do this here.
  return {
    saslStart: 1,
    mechanism,
    payload: new Binary(
      Buffer.concat([Buffer.from('n,,', 'utf8'), clientFirstMessageBare(username, nonce)])
    ),
    autoAuthorize: 1,
    options: { skipEmptyExchange: true }
  };
}

function executeScram(cryptoMethod: CryptoMethod, authContext: AuthContext, callback: Callback) {
  const connection = authContext.connection;
  const credentials = authContext.credentials;
  if (!authContext.nonce) {
    return callback(new MongoError('AuthContext must contain a valid nonce property'));
  }
  const nonce = authContext.nonce;
  const db = credentials.source;

  const saslStartCmd = makeFirstMessage(cryptoMethod, credentials, nonce);
  connection.command(`${db}.$cmd`, saslStartCmd, (_err, result) => {
    const err = resolveError(_err, result);
    if (err) {
      return callback(err);
    }

    continueScramConversation(cryptoMethod, result.result, authContext, callback);
  });
}

function continueScramConversation(
  cryptoMethod: CryptoMethod,
  response: Document,
  authContext: AuthContext,
  callback: Callback
) {
  const connection = authContext.connection;
  const credentials = authContext.credentials;
  if (!authContext.nonce) {
    return callback(new MongoError('Unable to continue SCRAM without valid nonce'));
  }
  const nonce = authContext.nonce;

  const db = credentials.source;
  const username = cleanUsername(credentials.username);
  const password = credentials.password;

  let processedPassword;
  if (cryptoMethod === 'sha256') {
    processedPassword = saslprep ? saslprep(password) : password;
  } else {
    try {
      processedPassword = passwordDigest(username, password);
    } catch (e) {
      return callback(e);
    }
  }

  const payload = Buffer.isBuffer(response.payload)
    ? new Binary(response.payload)
    : response.payload;
  const dict = parsePayload(payload.value());

  const iterations = parseInt(dict.i, 10);
  if (iterations && iterations < 4096) {
    callback(new MongoError(`Server returned an invalid iteration count ${iterations}`), false);
    return;
  }

  const salt = dict.s;
  const rnonce = dict.r;
  if (rnonce.startsWith('nonce')) {
    callback(new MongoError(`Server returned an invalid nonce: ${rnonce}`), false);
    return;
  }

  // Set up start of proof
  const withoutProof = `c=biws,r=${rnonce}`;
  const saltedPassword = HI(
    processedPassword,
    Buffer.from(salt, 'base64'),
    iterations,
    cryptoMethod
  );

  const clientKey = HMAC(cryptoMethod, saltedPassword, 'Client Key');
  const serverKey = HMAC(cryptoMethod, saltedPassword, 'Server Key');
  const storedKey = H(cryptoMethod, clientKey);
  const authMessage = [
    clientFirstMessageBare(username, nonce),
    payload.value().toString('base64'),
    withoutProof
  ].join(',');

  const clientSignature = HMAC(cryptoMethod, storedKey, authMessage);
  const clientProof = `p=${xor(clientKey, clientSignature)}`;
  const clientFinal = [withoutProof, clientProof].join(',');

  const serverSignature = HMAC(cryptoMethod, serverKey, authMessage);
  const saslContinueCmd = {
    saslContinue: 1,
    conversationId: response.conversationId,
    payload: new Binary(Buffer.from(clientFinal))
  };

  connection.command(`${db}.$cmd`, saslContinueCmd, (_err, result) => {
    const err = resolveError(_err, result);
    if (err) {
      return callback(err);
    }

    const r = result.result;
    const parsedResponse = parsePayload(r.payload.value());
    if (!compareDigest(Buffer.from(parsedResponse.v, 'base64'), serverSignature)) {
      callback(new MongoError('Server returned an invalid signature'));
      return;
    }

    if (!r || r.done !== false) {
      return callback(err, r);
    }

    const retrySaslContinueCmd = {
      saslContinue: 1,
      conversationId: r.conversationId,
      payload: Buffer.alloc(0)
    };

    connection.command(`${db}.$cmd`, retrySaslContinueCmd, callback);
  });
}

function parsePayload(payload: string) {
  const dict: Document = {};
  const parts = payload.split(',');
  for (let i = 0; i < parts.length; i++) {
    const valueParts = parts[i].split('=');
    dict[valueParts[0]] = valueParts[1];
  }

  return dict;
}

function passwordDigest(username: string, password: string) {
  if (typeof username !== 'string') {
    throw new MongoError('username must be a string');
  }

  if (typeof password !== 'string') {
    throw new MongoError('password must be a string');
  }

  if (password.length === 0) {
    throw new MongoError('password cannot be empty');
  }

  const md5 = crypto.createHash('md5');
  md5.update(`${username}:mongo:${password}`, 'utf8');
  return md5.digest('hex');
}

// XOR two buffers
function xor(a: Buffer, b: Buffer) {
  if (!Buffer.isBuffer(a)) {
    a = Buffer.from(a);
  }

  if (!Buffer.isBuffer(b)) {
    b = Buffer.from(b);
  }

  const length = Math.max(a.length, b.length);
  const res = [];

  for (let i = 0; i < length; i += 1) {
    res.push(a[i] ^ b[i]);
  }

  return Buffer.from(res).toString('base64');
}

function H(method: CryptoMethod, text: Buffer) {
  return crypto.createHash(method).update(text).digest();
}

function HMAC(method: CryptoMethod, key: Buffer, text: Buffer | string) {
  return crypto.createHmac(method, key).update(text).digest();
}

interface HICache {
  [key: string]: Buffer;
}

let _hiCache: HICache = {};
let _hiCacheCount = 0;
function _hiCachePurge() {
  _hiCache = {};
  _hiCacheCount = 0;
}

const hiLengthMap = {
  sha256: 32,
  sha1: 20
};

function HI(data: string, salt: Buffer, iterations: number, cryptoMethod: CryptoMethod) {
  // omit the work if already generated
  const key = [data, salt.toString('base64'), iterations].join('_');
  if (_hiCache[key] !== undefined) {
    return _hiCache[key];
  }

  // generate the salt
  const saltedData = crypto.pbkdf2Sync(
    data,
    salt,
    iterations,
    hiLengthMap[cryptoMethod],
    cryptoMethod
  );

  // cache a copy to speed up the next lookup, but prevent unbounded cache growth
  if (_hiCacheCount >= 200) {
    _hiCachePurge();
  }

  _hiCache[key] = saltedData;
  _hiCacheCount += 1;
  return saltedData;
}

function compareDigest(lhs: Buffer, rhs: Uint8Array) {
  if (lhs.length !== rhs.length) {
    return false;
  }

  if (typeof crypto.timingSafeEqual === 'function') {
    return crypto.timingSafeEqual(lhs, rhs);
  }

  let result = 0;
  for (let i = 0; i < lhs.length; i++) {
    result |= lhs[i] ^ rhs[i];
  }

  return result === 0;
}

function resolveError(err?: UniversalError, result?: Document) {
  if (err) return err;

  if (result) {
    const r = result.result;
    if (r.$err || r.errmsg) return new MongoError(r);
  }
}

export class ScramSHA1 extends ScramSHA {
  constructor() {
    super('sha1');
  }
}

export class ScramSHA256 extends ScramSHA {
  constructor() {
    super('sha256');
  }
}
