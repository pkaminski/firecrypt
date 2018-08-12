export default class Crypto {
  constructor(options, spec) {
    this._spec = this._cleanSpecification(spec);
    this._encryptString = this._throwNotSetUpError;
    this._decryptString = this._throwNotSetUpError;

    this._patternRegexes = {};

    if (typeof LRUCache === 'function') {
      this._encryptionCache = new LRUCache({
        max: options.encryptionCacheSize,
        length: this._computeCacheItemSize,
      });
      this._decryptionCache = new LRUCache({
        max: options.decryptionCacheSize,
        length: this._computeCacheItemSize,
      });
    }
  }

  _cleanSpecification(def, path) {
    var keys = Object.keys(def);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === '.encrypt') {
        var encryptKeys = Object.keys(def[key]);
        for (var j = 0; j < encryptKeys.length; j++) {
          var encryptKey = encryptKeys[j];
          if (encryptKey !== 'key' && encryptKey !== 'value' && encryptKey !== 'few') {
            throw new Error('Illegal .encrypt subkey: ' + encryptKeys[j]);
          }
        }
      } else {
        if (/[\x00-\x1f\x7f\x91\x92\.#\[\]/]/.test(key) || /[$]/.test(key.slice(1))) {
          throw new Error('Illegal character in specification key: ' + key);
        }
        this._cleanSpecification(def[key], (path || '') + '/' + key);
      }
      switch (key.charAt(0)) {
        case '$':
          if (key === '$') break;
          if (def.$) throw new Error('Multiple wildcard keys in specification at ' + path);
          def.$ = def[key];
          delete def[key];
          break;
        case '.':
          if (key !== '.encrypt') throw new Error('Unknown directive at ' + path + ': ' + key);
          break;
      }
    }
    return def;
  }

  _throwNotSetUpError() {
    var e = new Error('Encryption not set up');
    e.firecrypt = 'NO_KEY';
    throw e;
  }

  _computeCacheItemSize(value, key) {
    return key.length + (typeof value === 'string' ? value.length : 4);
  }

  setStringEncryptionFunctions(encryptString, decryptString) {
    this._encryptString = encryptString;
    this._decryptString = decryptString;
  }

  encryptPath(path, def) {
    def = def || this._spec.rules;
    path = path.slice();
    for (var i = 0; i < path.length; i++) {
      def = def[path[i]] || def.$;
      if (!def) break;
      if (def['.encrypt'] && def['.encrypt'].key) {
        path[i] = this.encrypt(path[i], 'string', def['.encrypt'].key);
      }
    }
    return path;
  }

  encryptRef(ref, path) {
    var encryptedPath = this.encryptPath(path || this.refToPath(ref));
    return encryptedPath.length ? ref.root.child(encryptedPath.join('/')) : ref.root;
  }

  decryptRef(ref) {
    var path = this.refToPath(ref, true);
    var changed = false;
    for (var i = 0; i < path.length; i++) {
      var decryptedPathSegment = this.decrypt(path[i]);
      if (decryptedPathSegment !== path[i]) {
        path[i] = decryptedPathSegment;
        changed = true;
      }
    }
    return changed ? ref.root.child(path.join('/')) : ref;
  }

  specForPath(path, def) {
    def = def || this._spec.rules;
    for (var i = 0; def && i < path.length; i++) {
      def = def[path[i]] || def.$;
    }
    return def;
  }

  transformValue(path, value, transformType) {
    if (transformType !== 'encrypt' && transformType !== 'decrypt') {
      throw new Error(
        `Transform type must be either "encrypt" or "decrypt", but got "${transformType}".`
      );
    }
    const transform = transformType === 'encrypt' ? this.encrypt.bind(this) : this.decrypt.bind(this);
    return this.transformTree(value, this.specForPath(path), transform);
  }

  transformTree(value, def, transform) {
    if (!def) return value;
    var type = this.getType(value);
    var i;
    if (/^(string|number|boolean)$/.test(type)) {
      if (def['.encrypt'] && def['.encrypt'].value) {
        value = transform(value, type, def['.encrypt'].value);
      }
    } else if (type === 'object' && value !== null) {
      var transformedValue = {};
      for (var key in value) {
        if (!value.hasOwnProperty(key)) continue;
        var subValue = value[key], subDef;
        if (key.indexOf('/') >= 0) {  // for deep update keys
          var keyParts = key.split('/');
          subDef = def;
          for (i = 0; i < keyParts.length; i++) {
            if (transform === decrypt) {
              keyParts[i] = this.decrypt(keyParts[i]);
              subDef = subDef && (subDef[keyParts[i]] || subDef.$);
            } else {
              subDef = subDef && (subDef[keyParts[i]] || subDef.$);
              if (subDef && subDef['.encrypt'] && subDef['.encrypt'].key) {
                keyParts[i] = transform(keyParts[i], 'string', subDef['.encrypt'].key);
              }
            }
          }
          key = keyParts.join('/');
        } else {
          if (transform === this.decrypt) {
            key = this.decrypt(key);
            subDef = def[key] || def.$;
          } else {
            subDef = def[key] || def.$;
            if (subDef && subDef['.encrypt'] && subDef['.encrypt'].key) {
              key = transform(key, 'string', subDef['.encrypt'].key);
            }
          }
        }
        transformedValue[key] = this.transformTree(subValue, subDef, transform);
      }
      value = transformedValue;
    } else if (type === 'array') {
      if (!def.$) return value;
      for (i = 0; i < value.length; i++) value[i] = this.transformTree(value[i], def.$, transform);
    }
    return value;
  }

  refToPath(ref, encrypted) {
    var root = ref.root;
    if (ref === root) return [];
    var pathStr = decodeURIComponent(ref.toString().slice(root.toString().length));
    if (!encrypted && pathStr && pathStr.charAt(0) !== '.' &&
        /[\x00-\x1f\x7f\x91\x92\.#$\[\]]/.test(pathStr)) {
      throw new Error('Path contains invalid characters: ' + pathStr);
    }
    return pathStr.split('/');
  }

  encrypt(value, type, pattern) {
    var cacheKey;
    if (this._encryptionCache) {
      cacheKey = type.charAt(0) + pattern + '\x91' + value;
      if (this._encryptionCache.has(cacheKey)) return this._encryptionCache.get(cacheKey);
    }
    var result;
    if (pattern === '#') {
      result = this.encryptValue(value, type);
    } else {
      if (type !== 'string') {
        throw new Error('Can\'t encrypt a ' + type + ' using pattern [' + pattern + ']');
      }
      var match = value.match(this.compilePattern(pattern));
      if (!match) {
        throw new Error(
          'Can\'t encrypt as value doesn\'t match pattern [' + pattern + ']: ' + value);
      }
      var i = 0;
      result = pattern.replace(/[#\.]/g, function(placeholder) {
        var part = match[++i];
        if (placeholder === '#') part = this.encryptValue(part, 'string');
        return part;
      });
    }
    if (this._encryptionCache) this._encryptionCache.set(cacheKey, result);
    return result;
  }

  encryptValue(value, type) {
    if (!/^(string|number|boolean)$/.test(type)) throw new Error('Can\'t encrypt a ' + type);
    switch (type) {
      case 'number': value = '' + value; break;
      case 'boolean': value = value ? 't' : 'f'; break;
    }
    return '\x91' + type.charAt(0).toUpperCase() + this._encryptString(value) + '\x92';
  }

  decrypt(value) {
    if (this._decryptionCache && this._decryptionCache.has(value)) return this._decryptionCache.get(value);
    if (!/\x91/.test(value)) return value;
    var result;
    var match = value.match(/^\x91(.)([^\x92]*)\x92$/);
    if (match) {
      var decryptedString = this._decryptString(match[2]);
      switch (match[1]) {
        case 'S':
          result = decryptedString;
          break;
        case 'N':
          result = Number(decryptedString);
          // Check for NaN, since it's the only value where x !== x.
          if (result !== result) throw new Error('Invalid encrypted number: ' + decryptedString);
          break;
        case 'B':
          if (decryptedString === 't') result = true;
          else if (decryptedString === 'f') result = false;
          else throw new Error('Invalid encrypted boolean: ' + decryptedString);
          break;
        default:
          throw new Error('Invalid encrypted value type code: ' + match[1]);
      }
    } else {
      result = value.replace(/\x91(.)([^\x92]*)\x92/g, function(match, typeCode, encryptedString) {
        if (typeCode !== 'S') throw new Error('Invalid multi-segment encrypted value: ' + typeCode);
        return this._decryptString(encryptedString);
      });
    }
    if (this._decryptionCache) this._decryptionCache.set(value, result);
    return result;
  }

  getType(value) {
    if (Array.isArray(value)) return 'array';
    var type = typeof value;
    if (type === 'object') {
      if (value instanceof String) type = 'string';
      else if (value instanceof Number) type = 'number';
      else if (value instanceof Boolean) type = 'boolean';
    }
    return type;
  }

  compilePattern(pattern) {
    var regex = this._patternRegexes[pattern];
    if (!regex) {
      regex = this._patternRegexes[pattern] = new RegExp('^' + pattern
        .replace(/\./g, '#')
        .replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&')  // escape regex chars
        .replace(/#/g, '(.*?)') + '$');
    }
    return regex;
  }
}
