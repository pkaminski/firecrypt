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

  var fbp = Firebase.prototype;
  var originalQueryFbp = {};
  var firebaseWrapped = false;
  var encryptString, decryptString;

  var utils = require('./utils');

  Firebase.initializeEncryption = function(options, specification) {
    var result;
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
        result = setupAesSiv(options.key, options.keyCheckValue);
        break;
      case 'passthrough':
        encryptString = decryptString = function(str) {return str;};
        break;
      case 'none':
        break;
      default:
        throw new Error('Unknown encryption algorithm "' + options.algorithm + '".');
    }
    utils.setSpec(specification);
    wrapFirebase();
    return result;
  };

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

  function Query(query, order, original) {
    this._query = query;
    this._order = order || {};
    this._original = original || query;
  }
  Query.prototype.on = function(eventType, callback, cancelCallback, context) {
    wrapQueryCallback(callback);
    return this._original.on.call(
      this._query, eventType, callback.firecryptCallback, cancelCallback, context);
  };
  Query.prototype.off = function(eventType, callback, context) {
    if (callback && callback.firecryptCallback) callback = callback.firecryptCallback;
    return this._original.off.call(this._query, eventType, callback, context);
  };
  Query.prototype.once = function(eventType, successCallback, failureCallback, context) {
    wrapQueryCallback(successCallback);
    return this._original.once.call(
      this._query, eventType, successCallback && successCallback.firecryptCallback, failureCallback,
      context
    ).then(function(snap) {
      return new Snapshot(snap);
    });
  };
  Query.prototype.orderByChild = function(key) {
    return this._orderBy('orderByChild', 'child', key);
  };
  Query.prototype.orderByKey = function() {
    return this._orderBy('orderByKey', 'key');
  };
  Query.prototype.orderByValue = function() {
    return this._orderBy('orderByValue', 'value');
  };
  Query.prototype.orderByPriority = function() {
    return this._orderBy('orderByPriority', 'priority');
  };
  Query.prototype.startAt = function(value, key) {
    this._checkCanSort(key !== undefined);
    return this._delegate('startAt', arguments);
  };
  Query.prototype.endAt = function(value, key) {
    this._checkCanSort(key !== undefined);
    return this._delegate('endAt', arguments);
  };
  Query.prototype.equalTo = function(value, key) {
    if (this._order[this._order.by + 'Encrypted']) {
      value = utils.encrypt(value, utils.getType(value), this._order[this._order.by + 'Encrypted']);
    }
    if (key !== undefined && this._order.keyEncrypted) {
      key = utils.encrypt(key, 'string', this._order.keyEncrypted);
    }
    return new Query(this._original.equalTo.call(this._query, value, key), this._order);
  };
  Query.prototype.limitToFirst = function() {
    return this._delegate('limitToFirst', arguments);
  };
  Query.prototype.limitToLast = function() {
    return this._delegate('limitToLast', arguments);
  };
  Query.prototype.limit = function() {
    return this._delegate('limit', arguments);
  };
  Query.prototype.ref = function() {
    return utils.decryptRef(this._original.ref.call(this._query));
  };
  Query.prototype._delegate = function(methodName, args) {
    return new Query(this._original[methodName].apply(this._query, args), this._order);
  };
  Query.prototype._checkCanSort = function(hasExtraKey) {
    if (this._order.by === 'key' ?
        this._order.keyEncrypted :
        this._order.valueEncrypted || hasExtraKey && this._order.keyEncrypted) {
      throw new Error('Encrypted items cannot be ordered');
    }
  };
  Query.prototype._orderBy = function(methodName, by, childKey) {
    var def = utils.specForPath(utils.refToPath(this.ref()));
    var order = {by: by};
    var encryptedChildKey;
    if (def) {
      var childPath = childKey && childKey.split('/');
      for (var subKey in def) {
        if (!def.hasOwnProperty(subKey)) continue;
        var subDef = def[subKey];
        if (subDef['.encrypt']) {
          if (subDef['.encrypt'].key) order.keyEncrypted = subDef['.encrypt'].key;
          if (subDef['.encrypt'].value) order.valueEncrypted = subDef['.encrypt'].value;
        }
        if (childKey) {
          var childDef = utils.specForPath(childPath, subDef);
          if (childDef && childDef['.encrypt'] && childDef['.encrypt'].value) {
            order.childEncrypted = childDef['.encrypt'].value;
          }
          var encryptedChildKeyCandidate = utils.encryptPath(childPath, subDef).join('/');
          if (encryptedChildKey && encryptedChildKeyCandidate !== encryptedChildKey) {
            throw new Error(
              'Incompatible encryption specifications for orderByChild("' + childKey + '")');
          }
          encryptedChildKey = encryptedChildKeyCandidate;
        }
      }
    }
    if (childKey) {
      return new Query(
        this._original[methodName].call(this._query, encryptedChildKey || childKey), order);
    } else {
      return new Query(this._original[methodName].call(this._query), order);
    }
  };


  function Snapshot(snap) {
    this._ref = utils.decryptRef(snap.ref());
    this._path = utils.refToPath(this._ref);
    this._snap = snap;
  }
  delegateSnapshot('exists');
  delegateSnapshot('hasChildren');
  delegateSnapshot('numChildren');
  delegateSnapshot('getPriority');
  Snapshot.prototype.val = function() {
    return utils.transformValue(this._path, this._snap.val(), utils.decrypt);
  };
  Snapshot.prototype.child = function(childPath) {
    return new Snapshot(this._snap.child(childPath));
  };
  Snapshot.prototype.forEach = function(action) {
    return this._snap.forEach(function(childSnap) {
      return action(new Snapshot(childSnap));
    });
  };
  Snapshot.prototype.hasChild = function(childPath) {
    childPath = utils.encryptPath(childPath.split('/'), utils.specForPath(this._path)).join('/');
    return this._snap.hasChild(childPath);
  };
  Snapshot.prototype.key = function() {
    return this._ref.key();
  };
  Snapshot.prototype.name = function() {
    return this._ref.name();
  };
  Snapshot.prototype.ref = function() {
    return this._ref;
  };
  Snapshot.prototype.exportVal = function() {
    return utils.transformValue(this._path, this._snap.exportVal(), utils.decrypt);
  };

  function OnDisconnect(path, originalOnDisconnect) {
    this._path = path;
    this._originalOnDisconnect = originalOnDisconnect;
  }
  interceptOnDisconnectWrite('set', 0);
  interceptOnDisconnectWrite('update', 0);
  interceptOnDisconnectWrite('remove');
  interceptOnDisconnectWrite('setWithPriority', 0);
  interceptOnDisconnectWrite('cancel');


  function wrapFirebase() {
    if (firebaseWrapped) return;
    interceptWrite('set', 0);
    interceptWrite('update', 0);
    interceptPush();
    interceptWrite('setWithPriority', 0);
    interceptWrite('setPriority');
    if (fbp.childrenKeys) interceptChildrenKeys();
    interceptTransaction();
    interceptOnDisconnect();
    [
      'on', 'off', 'once', 'orderByChild', 'orderByKey', 'orderByValue', 'orderByPriority',
      'startAt', 'endAt', 'equalTo', 'limitToFirst', 'limitToLast', 'limit', 'ref'
    ].forEach(function(methodName) {interceptQuery(methodName);});
    firebaseWrapped = true;
  }

  function interceptWrite(methodName, argIndex) {
    var originalMethod = fbp[methodName];
    fbp[methodName] = function() {
      var path = utils.refToPath(this);
      var self = utils.encryptRef(this, path);
      var args = Array.prototype.slice.call(arguments);
      if (argIndex >= 0 && argIndex < args.length) {
        args[argIndex] = utils.transformValue(path, args[argIndex], encrypt);
      }
      return originalMethod.apply(self, args);
    };
  }

  function interceptPush() {
    // Firebase.push delegates to Firebase.set, which will take care of encrypting the ref and the
    // argument.
    var originalMethod = fbp.push;
    fbp.push = function() {
      var ref = originalMethod.apply(this, arguments);
      var decryptedRef = utils.decryptRef(ref);
      decryptedRef.then = ref.then;
      decryptedRef.catch = ref.catch;
      if (ref.finally) decryptedRef.finally = ref.finally;
      return decryptedRef;
    };
  }

  function interceptChildrenKeys() {
    var originalMethod = fbp.childrenKeys;
    fbp.childrenKeys = function() {
      return originalMethod.apply(utils.encryptRef(this), arguments).then(function(keys) {
        if (!keys.some(function(key) {return /\x91/.test(key);})) return keys;
        return keys.map(utils.decrypt);
      });
    };
  }

  function interceptTransaction() {
    var originalMethod = fbp.transaction;
    fbp.transaction = function() {
      var path = utils.refToPath(this);
      var self = utils.encryptRef(this, path);
      var args = Array.prototype.slice.call(arguments);
      var originalCompute = args[0];
      args[0] = originalCompute && function(value) {
        value = utils.transformValue(path, value, decrypt);
        value = originalCompute(value);
        value = utils.transformValue(path, value, encrypt);
        return value;
      };
      if (args.length > 1) {
        var originalOnComplete = args[1];
        args[1] = originalOnComplete && function(error, committed, snapshot) {
          return originalOnComplete(error, committed, snapshot && new Snapshot(snapshot));
        };
      }
      return originalMethod.apply(self, args).then(function(result) {
        result.snapshot = result.snapshot && new Snapshot(result.snapshot);
        return result;
      });
    };
  }

  function interceptOnDisconnect() {
    var originalMethod = fbp.onDisconnect;
    fbp.onDisconnect = function() {
      var path = utils.refToPath(this);
      return new OnDisconnect(path, originalMethod.call(utils.encryptRef(this, path)));
    };
  }

  function interceptOnDisconnectWrite(methodName, argIndex) {
    OnDisconnect.prototype[methodName] = function() {
      var args = Array.prototype.slice.call(arguments);
      if (argIndex >= 0 && argIndex < args.length) {
        args[argIndex] = utils.transformValue(this._path, args[argIndex], utils.encrypt);
      }
      console.log('ARGS:', args);
      return this._originalOnDisconnect[methodName].apply(this._originalOnDisconnect, args);
    };
  }

  function interceptQuery(methodName) {
    originalQueryFbp[methodName] = fbp[methodName];
    fbp[methodName] = function() {
      var query = new Query(utils.encryptRef(this), {}, originalQueryFbp);
      return query[methodName].apply(query, arguments);
    };
  }

  function wrapQueryCallback(callback) {
    if (!callback || callback.firecryptCallback) return;
    var wrappedCallback = function(snap, previousChildKey) {
      return callback.call(this, new Snapshot(snap), previousChildKey);
    };
    wrappedCallback.firecryptCallback = wrappedCallback;
    callback.firecryptCallback = wrappedCallback;
  }

  function delegateSnapshot(methodName) {
    Snapshot.prototype[methodName] = function() {
      return this._snap[methodName].apply(this._snap, arguments);
    };
  }
})();