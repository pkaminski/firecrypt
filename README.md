# firecrypt
Transparent encryption for Firebase

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
  * `none`: no encryption, will throw an error if you attempt to read or write any encrypted path.
* `key`: the required key for algorithm `aes-siv`.  Must be 32, 48, or 64 bytes, encoded in base 64.  You can generate such a key using `openssl rand -base64 64`.
* `cacheSize`: the maximum size in bytes of the encryption and decryption caches, used to improve performance.  In the browser, the caches will only be activated if `LRUCache` is defined; it should conform to the API of [`node-lru-cache`](https://github.com/isaacs/node-lru-cache).  You can also specify `encryptionCacheSize` and `decryptionCacheSize` separately.

If the `algorithm` is `aes-siv` then `initializeEncryption` will return a key signature that can be used to verify whether another key matches.  This can be useful if the key is distributed as part of a session, and you want to check if you need to invalidate the session because the key has been rotated.  Also, if the key doesn't match then decrypting will throw an exception later (most likely, anyway, as the signature is very short so as not to bloat the datastore size too much).

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

You may want to check out [`fireplan`](https://github.com/pkaminski/fireplan) for a convenient way to generate the encryption specification from your security rules schema.
