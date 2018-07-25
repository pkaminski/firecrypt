# firecrypt &mdash; transparent at-rest AES encryption for Firebase

[![Project Status: Active - The project has reached a stable, usable state and is being actively developed.](http://www.repostatus.org/badges/latest/active.svg)](http://www.repostatus.org/#active)

First: this library only makes sense if your clients sit behind a firewall, or if you control who can get an account and anonymous users don't need to access encrypted data.  Otherwise, the encryption key will be public defeating the whole point.

This library monkey-patches the Firebase JavaScript SDK (currently only version 2.4.2) to automatically encrypt and decrypt keys and values of your choosing using AES-SIV.  Almost everything just works, except that `startAt` and `endAt` queries on encrypted data would produce randomly ordered results and so are forbidden.  `equalTo` queries will work fine, however, since a given plaintext value will always encrypt to the same ciphertext &mdash; but it will also let an attacker know if any two values are equal, even if they don't know what they are.

The library works both in Node (4.x+) and in the browser.  In the browser, you need to also load [`crypto-js`](https://github.com/brix/crypto-js) (the following modules are sufficient: `core.js`, `enc-base64.js`, `md5.js`, `evpkdf.js`, `cipher-core.js`, `aes.js`, `mode-ctr.js`) and [`cryptojs-extension`](https://github.com/artjomb/cryptojs-extension) (only `build/siv.js` is required).  If you want to enable caching to enhance performance, then in the browser you'll also want to load [`node-lru-cache`](https://github.com/isaacs/node-lru-cache).  All these libraries are automatically included in the Node distribution.

The library exposes only one function:
```js
Firebase.initializeEncryption(options, specification)
```

The options are as follows:

* `algorithm`: the crypto algorithm to use.  Currently supported values are:
  * `aes-siv`: actual encryption using AES-SIV.
  * `passthrough`: fake encryption using an identity transform, useful for debugging.
  * `none`: no encryption, will throw an error with `firecrypt === 'NO_KEY'` if you attempt to read or write any encrypted path.
* `key`: the required key for algorithm `aes-siv`.  Must be 32, 48, or 64 bytes, encoded in base 64.  You can generate such a key using `openssl rand -base64 64`.  If you attempt to decrypt a value with the wrong key then an error with `firecrypt === 'WRONG_KEY'` will be thrown.
* `keyCheckValue`: a value generated by a previous call to `initializeEncryption` used to verify that the `aes-siv` `key` used in both calls is the same.  If a different key was used to generate the `keyCheckValue` then an error with `firecrypt === 'WRONG_KEY'` will be thrown.
* `cacheSize`: the maximum size in bytes of the encryption and decryption caches, used to improve performance.  In the browser, the caches will only be activated if `LRUCache` is defined; it should conform to the API of [`node-lru-cache`](https://github.com/isaacs/node-lru-cache).  You can also specify `encryptionCacheSize` and `decryptionCacheSize` separately.

If the `algorithm` is `aes-siv` then `initializeEncryption` will return a value that can be used to synchronously verify whether another key matches by passing it via `keyCheckValue`.  This can be useful if the key is distributed as part of a session, and you want to check if you need to invalidate the session because the key has been rotated.  Also, if the key doesn't match then decrypting will throw an exception later.

The `specification` is a JSON structure similar to Firebase security rules but specifying which keys and values need to be encrypted instead.  The structure mimics that of your datastore and uses `$wildcards` in the same manner as security rules.

```js
{
  "rules": {
    "foo": {
      ".encrypt": {"value": "#"}
    },
    "bar": {
      "$baz": {
        ".encrypt": {"key": "#-#-."}
      }
    }
  }
}
```

Each `.encrypt` directive can require the key or value (or both) at that path to be encrypted.  The parameter is an encryption pattern, where `#` are placeholders for chunks to be encrypted, `.` for chunks that should not be encrypted, and everything else is matched verbatim to the plaintext data.  Normally, you'll just use a single `#` to encrypt the entire key or value, but sometimes it can be useful to encrypt only specific parts of a composite key.  You can also specify an empty pattern to explicitly indicate that something should _not_ be encrypted, which is only useful if you're encrypting a sibling wildcard key but don't want some specific instances to be encrypted.

You must specify value encryption at the atomic data leaves only &mdash; it's not valid to encrypt an object and trying to do so will throw an exception at runtime.  There's currently no way to require encryption for an entire subtree.

For bulk encryption/decryption (including key rotation), you can also specify `".encrypt": {"few": true}` on wildcard keys (whether encrypted or not) where the number of children is expected to be low enough that it's reasonable to read or write them all at once.

You may want to check out [`fireplan`](https://github.com/pkaminski/fireplan) for a convenient way to generate the encryption specification from your security rules schema.  See also [`firecrypt-tools`](https://github.com/pkaminski/firecrypt/tree/master/tools) for related utilities.

## Local Setup

Run the following commands from the command line to get your local environment set up:

```bash
$ git clone git@github.com:Reviewable/firecrypt.git
$ cd firecrypt    # go to the firecrypt directory
$ npm install     # install local npm dependencies
```

Run the following command to build the distribution files for the library:

```bash
$ npm run build
```

This will generate the following distribution files, along with accompanying source maps:

* `dist/node/firecrypt.js` - A non-minified CommonJS build of the library for use in Node.js.
* `dist/browser/firecrypt.js` - A non-minified IIFE build of the library for use in the browser.
* `dist/browser/firecrypt.min.js` - A minified IIFE build of the library for use in the browser.
