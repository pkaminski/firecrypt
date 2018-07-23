if (typeof require !== 'undefined') {
  if (typeof Firebase === 'undefined') Firebase = require('firebase');
  if (typeof LRUCache === 'undefined') LRUCache = require('lru-cache');
  if (typeof CryptoJS === 'undefined') CryptoJS = require('crypto-js/core');
  require('crypto-js/enc-base64');
  require('cryptojs-extension/build_node/siv');
  try {
    require('firebase-childrenkeys');
  } catch (e) {
    // ignore, not installed
  }
}

CryptoJS.enc.Base64UrlSafe = {
  stringify: CryptoJS.enc.Base64.stringify,
  parse: CryptoJS.enc.Base64.parse,
  _map: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
};

(function() {
  'use strict';

  const utils = require('./utils');
  const FireCryptReference = require('./FireCryptReference');

  let encryptString
  let decryptString;

  class FireCrypt {
    constructor(db, options = {}, specification = {}) {
      const dbIsNonNullObject = (typeof db === 'object' && db !== null);
      if (!dbIsNonNullObject || typeof db.app !== 'object' || typeof db.ref !== 'function') {
        throw new Error(
          `Expected first argument passed to FireCrypt constructor to be a Firebase Database instance, 
          but got "${db}".`
        );
      } else if (typeof options !== 'object' || options === null) {
        throw new Error(
          `Expected second argument passed to FireCrypt constructor to be an object, but got "${options}".`
        );
      } else if (typeof specification !== 'object' || specification === null) {
        throw new Error(
          `Expected third argument passed to FireCrypt constructor to be an object, but got "${specification}".`
        );
      }
  
      this._db = db;

      options.cacheSize = options.cacheSize || 5 * 1000 * 1000;
      options.encryptionCacheSize = options.encryptionCacheSize || options.cacheSize;
      options.decryptionCacheSize = options.decryptionCacheSize || options.cacheSize;
      encryptString = decryptString = utils.throwNotSetUpError;
      
      if (typeof LRUCache === 'function') {
        utils.setEncryptionCache(new LRUCache({
          max: options.encryptionCacheSize, length: utils.computeCacheItemSize
        }));
        utils.setDecryptionCache(new LRUCache({
          max: options.decryptionCacheSize, length: utils.computeCacheItemSize
        }));
      }
  
      switch (options.algorithm) {
        case 'aes-siv':
          if (!options.key) throw new Error('You must specify a key to use AES encryption.');
          // TODO: update things that use this
          this.encryptionKeyCheckValue = setupAesSiv(options.key, options.keyCheckValue);
          break;
        case 'passthrough':
          encryptString = decryptString = (str) => str;
          break;
        case 'none':
          break;
        default:
          throw new Error('Unknown encryption algorithm "' + options.algorithm + '".');
      }
  
      utils.setSpec(specification);

      return this;
    }

    get app() {
      return this._db.app;
    }
  
    goOnline() {
      return this._db.goOnline();
    }
  
    goOffline() {
      return this._db.goOffline();
    }
  
    ref(pathOrRef) {
      // TODO: validate pathOrRef
  
      return new FireCryptReference(this._db.ref(pathOrRef));
    }
  }

  function setupAesSiv(key, checkValue) {
    var siv = CryptoJS.SIV.create(CryptoJS.enc.Base64.parse(key));
    encryptString = function(str) {
      return CryptoJS.enc.Base64UrlSafe.stringify(siv.encrypt(str));
    };
    decryptString = function(str) {
      var result = siv.decrypt(CryptoJS.enc.Base64UrlSafe.parse(str));
      if (result === false) {
        var e = new Error('Wrong decryption key');
        e.firecrypt = 'WRONG_KEY';
        throw e;
      }
      return CryptoJS.enc.Utf8.stringify(result);
    };
    if (checkValue) decryptString(checkValue);
    return encryptString(CryptoJS.enc.Base64UrlSafe.stringify(CryptoJS.lib.WordArray.random(10)));
  }

  module.exports = FireCrypt;
})();
