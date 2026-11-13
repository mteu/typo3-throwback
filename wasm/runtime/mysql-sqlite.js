// A MySQL 3.23 server for libmysql/libmysql.c, kept in SQLite (sql.js).
//
// It answers what TYPO3 3.x and its install tooling send, not every MySQL
// statement. SQL is tokenized with MySQL's rules (backslash escapes, both
// quote styles, backticks, "#" comments) and re-emitted for SQLite. Each
// table's MySQL definition is kept beside it, in __phpwasm_mysql_tables, so
// SHOW COLUMNS, field types and flags answer as MySQL would, and writes get
// MySQL's non-strict conversions: '' into an int column is 0, NULL into a NOT
// NULL column is its default, varchar(n) truncates, and 0 or NULL into an
// auto_increment column takes the next id.
//
// Strings are ISO-8859-1 throughout: one JS char per byte, as PHP 4 sends them.
//
// Every error it raises is one MySQL raises for the same statement, with
// MySQL's number. A statement it cannot translate fails in SQLite instead,
// as error 1105 with SQLite's message. The stack probes,
// probe/stack-<release>.cjs, record every statement answered with an error
// and fail on any. For TYPO3 3.3.0 and 3.8.1 there are none, over what those
// probes reach: provisioning, the frontend, the backend login, record
// editing, uploads and the Install Tool. Beyond that, probe/mysql-sqlite.cjs
// covers the ALTER TABLE forms the Install Tool's database compare sends.
// Other statements are untested.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MysqlOnSqlite = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const FIELD_TYPE = {
    DECIMAL: 0, TINY: 1, SHORT: 2, LONG: 3, FLOAT: 4, DOUBLE: 5, NULL: 6,
    TIMESTAMP: 7, LONGLONG: 8, INT24: 9, DATE: 10, TIME: 11, DATETIME: 12,
    YEAR: 13, BLOB: 252, VAR_STRING: 253, STRING: 254,
  };
  const FLAG = {
    NOT_NULL: 1, PRI_KEY: 2, UNIQUE_KEY: 4, MULTIPLE_KEY: 8, BLOB: 16,
    UNSIGNED: 32, ZEROFILL: 64, BINARY: 128, ENUM: 256, AUTO_INCREMENT: 512,
    TIMESTAMP: 1024, SET: 2048, NUM: 32768,
  };
  // Server error numbers and message formats as MySQL 3.23 sends them.
  const ER = {
    DB_CREATE_EXISTS: 1007, DB_DROP_EXISTS: 1008, ACCESS_DENIED: 1045,
    NO_DB: 1046, BAD_DB: 1049, TABLE_EXISTS: 1050, BAD_TABLE: 1051,
    BAD_FIELD: 1054, DUP_ENTRY: 1062, PARSE: 1064, EMPTY_QUERY: 1065,
    KEY_DOES_NOT_EXIST: 1091, UNKNOWN: 1105, NO_SUCH_TABLE: 1146,
    NOT_SUPPORTED: 1235,
  };
  const CATALOG = '__phpwasm_mysql_tables';
  const REBUILD = '__phpwasm_rebuild';
  const INTERNAL_PREFIX = '__phpwasm_';

  class MysqlError extends Error {
    constructor(errno, message) {
      super(message);
      this.errno = errno;
    }
  }

  // ---------------------------------------------------------------------
  // Tokens

  const OPERATORS = ['<=>', '<=', '>=', '<>', '!=', '||', '&&', '<<', '>>', ':='];
  const WORD_CHAR = /[A-Za-z0-9_$\u0080-ÿ]/;
  const NUMBER = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/;
  const ESCAPES = { 0: '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' };

  function tokenize(sql) {
    const tokens = [];
    let i = 0;
    const n = sql.length;
    while (i < n) {
      const c = sql[i];
      if (/\s/.test(c)) {
        i++;
      } else if (c === '#' || (c === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
        while (i < n && sql[i] !== '\n') {
          i++;
        }
      } else if (c === '/' && sql[i + 1] === '*') {
        if (sql[i + 2] === '!') {
          // A versioned comment is code to MySQL: /*!32312 IF NOT EXISTS*/.
          i += 3;
          while (i < n && /\d/.test(sql[i])) {
            i++;
          }
          const close = sql.indexOf('*/', i);
          const inner = sql.slice(i, close < 0 ? n : close);
          for (const token of tokenize(inner)) {
            token.start += i;
            token.end += i;
            tokens.push(token);
          }
          i = close < 0 ? n : close + 2;
        } else {
          const close = sql.indexOf('*/', i + 2);
          i = close < 0 ? n : close + 2;
        }
      } else if (c === "'" || c === '"') {
        const start = i;
        let value = '';
        i++;
        for (;;) {
          if (i >= n) {
            throw syntaxError(sql, start);
          }
          const d = sql[i];
          if (d === '\\' && i + 1 < n) {
            const e = sql[i + 1];
            // MySQL keeps the backslash before % and _, for LIKE.
            value += e === '%' || e === '_' ? `\\${e}` : (ESCAPES[e] !== undefined ? ESCAPES[e] : e);
            i += 2;
          } else if (d === c && sql[i + 1] === c) {
            value += c;
            i += 2;
          } else if (d === c) {
            i++;
            break;
          } else {
            value += d;
            i++;
          }
        }
        tokens.push({ type: 'string', value, start, end: i });
      } else if (c === '`') {
        const start = i;
        const close = sql.indexOf('`', i + 1);
        if (close < 0) {
          throw syntaxError(sql, start);
        }
        tokens.push({ type: 'ident', value: sql.slice(i + 1, close), start, end: close + 1 });
        i = close + 1;
      } else if (/[0-9.]/.test(c) && NUMBER.test(sql.slice(i, i + 40)) && !(c === '.' && tokens.length && isNameToken(tokens[tokens.length - 1]) && tokens[tokens.length - 1].end === i)) {
        const text = sql.slice(i).match(NUMBER)[0];
        if (WORD_CHAR.test(sql[i + text.length] || '') && !/^0x/i.test(text)) {
          const start = i;
          while (i < n && WORD_CHAR.test(sql[i])) {
            i++;
          }
          const word = sql.slice(start, i);
          tokens.push({ type: 'word', value: word, upper: word.toUpperCase(), start, end: i });
        } else {
          tokens.push({ type: 'number', value: text, start: i, end: i + text.length });
          i += text.length;
        }
      } else if (WORD_CHAR.test(c)) {
        const start = i;
        while (i < n && WORD_CHAR.test(sql[i])) {
          i++;
        }
        const word = sql.slice(start, i);
        tokens.push({ type: 'word', value: word, upper: word.toUpperCase(), start, end: i });
      } else {
        const op = OPERATORS.find(candidate => sql.startsWith(candidate, i)) || c;
        tokens.push({ type: 'op', value: op, start: i, end: i + op.length });
        i += op.length;
      }
    }
    return tokens;
  }

  function isNameToken(token) {
    return token && (token.type === 'word' || token.type === 'ident');
  }

  function syntaxError(sql, offset) {
    const near = sql.slice(offset, offset + 80);
    return new MysqlError(ER.PARSE, `You have an error in your SQL syntax near '${near}' at line 1`);
  }

  class TokenStream {
    constructor(tokens, sql) {
      this.tokens = tokens;
      this.sql = sql;
      this.i = 0;
    }

    peek(offset = 0) {
      return this.tokens[this.i + offset];
    }

    next() {
      return this.tokens[this.i++];
    }

    atEnd() {
      return this.i >= this.tokens.length;
    }

    isWord(...uppers) {
      const token = this.peek();
      return token !== undefined && token.type === 'word' && uppers.includes(token.upper);
    }

    isOp(value) {
      const token = this.peek();
      return token !== undefined && token.type === 'op' && token.value === value;
    }

    acceptWord(...uppers) {
      if (this.isWord(...uppers)) {
        return this.next();
      }
      return null;
    }

    acceptOp(value) {
      if (this.isOp(value)) {
        return this.next();
      }
      return null;
    }

    expectWord(...uppers) {
      const token = this.acceptWord(...uppers);
      if (!token) {
        throw this.error();
      }
      return token;
    }

    expectOp(value) {
      const token = this.acceptOp(value);
      if (!token) {
        throw this.error();
      }
      return token;
    }

    name() {
      const token = this.next();
      if (!isNameToken(token)) {
        this.i--;
        throw this.error();
      }
      // db.table: the database part is dropped; one database per connection.
      if (this.isOp('.') && isNameToken(this.peek(1))) {
        this.next();
        return this.next().value;
      }
      return token.value;
    }

    // Tokens up to the next top-level occurrence of one of the stop words or
    // ops, or to the end.
    until(stopWords = [], stopOps = []) {
      const start = this.i;
      let depth = 0;
      while (!this.atEnd()) {
        const token = this.peek();
        if (depth === 0 && ((token.type === 'word' && stopWords.includes(token.upper))
            || (token.type === 'op' && stopOps.includes(token.value)))) {
          break;
        }
        if (token.type === 'op' && token.value === '(') {
          depth++;
        } else if (token.type === 'op' && token.value === ')') {
          if (depth === 0) {
            break;
          }
          depth--;
        }
        this.i++;
      }
      return this.tokens.slice(start, this.i);
    }

    error() {
      const token = this.peek();
      return syntaxError(this.sql, token ? token.start : this.sql.length);
    }
  }

  function splitTopLevel(tokens, separator = ',') {
    const parts = [];
    let current = [];
    let depth = 0;
    for (const token of tokens) {
      if (token.type === 'op' && token.value === '(') {
        depth++;
      } else if (token.type === 'op' && token.value === ')') {
        depth--;
      }
      if (depth === 0 && token.type === 'op' && token.value === separator) {
        parts.push(current);
        current = [];
      } else {
        current.push(token);
      }
    }
    if (current.length) {
      parts.push(current);
    }
    return parts;
  }

  // ---------------------------------------------------------------------
  // SQLite output

  function quoteString(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
  }

  function quoteIdent(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
  }

  // MySQL function names SQLite spells differently, or whose SQLite built-in
  // behaves differently. A variadic application function does not override a
  // variadic built-in, so MySQL's CONCAT (NULL if any argument is NULL) goes
  // by another name. The functions SQLite lacks are registered under their
  // own names by registerFunctions().
  const FUNCTION_NAMES = { IF: 'IIF', CONCAT: 'MYSQL_CONCAT', CONCAT_WS: 'MYSQL_CONCAT_WS' };

  function emitToken(token, next) {
    switch (token.type) {
      case 'string':
        return quoteString(token.value);
      case 'ident':
        return quoteIdent(token.value);
      case 'word':
        if (next && next.type === 'op' && next.value === '(' && FUNCTION_NAMES[token.upper]) {
          return FUNCTION_NAMES[token.upper];
        }
        return token.value;
      case 'op':
        if (token.value === '&&') {
          return 'AND';
        }
        if (token.value === '||') {
          return 'OR';
        }
        if (token.value === '!') {
          return 'NOT';
        }
        if (token.value === '<=>') {
          return 'IS';
        }
        return token.value;
      default:
        return token.value;
    }
  }

  // Joins tokens back into SQL. No space before "(" after a name, or around
  // ".", so emitted expressions read as written: count(*), pages.uid.
  function emit(tokens) {
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const previous = tokens[i - 1];
      let text = emitToken(token, tokens[i + 1]);
      // MySQL's LIKE escapes with a backslash by default; SQLite's needs ESCAPE.
      if (token.type === 'string' && previous && previous.type === 'word' && previous.upper === 'LIKE'
          && token.value.includes('\\') && !(tokens[i + 1] && tokens[i + 1].upper === 'ESCAPE')) {
        text += " ESCAPE '\\'";
      }
      const tight = previous && (
        (token.type === 'op' && (token.value === '.' || token.value === ',' || token.value === ')'))
        || (previous.type === 'op' && (previous.value === '.' || previous.value === '('))
        || (token.type === 'op' && token.value === '(' && previous.type === 'word'));
      out += (out && !tight ? ' ' : '') + text;
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Column types

  const INTEGER_TYPES = {
    TINYINT: { field: FIELD_TYPE.TINY, bits: 8, width: 4 },
    SMALLINT: { field: FIELD_TYPE.SHORT, bits: 16, width: 6 },
    MEDIUMINT: { field: FIELD_TYPE.INT24, bits: 24, width: 9 },
    INT: { field: FIELD_TYPE.LONG, bits: 32, width: 11 },
    INTEGER: { field: FIELD_TYPE.LONG, bits: 32, width: 11 },
    BIGINT: { field: FIELD_TYPE.LONGLONG, bits: 64, width: 20 },
  };
  const FLOAT_TYPES = {
    FLOAT: { field: FIELD_TYPE.FLOAT, width: 12 },
    DOUBLE: { field: FIELD_TYPE.DOUBLE, width: 22 },
    REAL: { field: FIELD_TYPE.DOUBLE, width: 22 },
    DECIMAL: { field: FIELD_TYPE.DECIMAL, width: 10 },
    NUMERIC: { field: FIELD_TYPE.DECIMAL, width: 10 },
    DEC: { field: FIELD_TYPE.DECIMAL, width: 10 },
  };
  const TEXT_TYPES = {
    TINYTEXT: 255, TEXT: 65535, MEDIUMTEXT: 16777215, LONGTEXT: 4294967295,
    TINYBLOB: 255, BLOB: 65535, MEDIUMBLOB: 16777215, LONGBLOB: 4294967295,
  };
  const DATE_TYPES = {
    DATE: { field: FIELD_TYPE.DATE, width: 10 },
    TIME: { field: FIELD_TYPE.TIME, width: 8 },
    DATETIME: { field: FIELD_TYPE.DATETIME, width: 19 },
    TIMESTAMP: { field: FIELD_TYPE.TIMESTAMP, width: 14 },
    YEAR: { field: FIELD_TYPE.YEAR, width: 4 },
  };

  function typeKind(base) {
    if (INTEGER_TYPES[base]) {
      return 'integer';
    }
    if (FLOAT_TYPES[base]) {
      return 'float';
    }
    if (base === 'CHAR' || base === 'VARCHAR' || base === 'ENUM' || base === 'SET'
        || (TEXT_TYPES[base] && base.endsWith('TEXT'))) {
      return 'text';
    }
    if (TEXT_TYPES[base]) {
      return 'blob';
    }
    if (DATE_TYPES[base]) {
      return 'date';
    }
    return null;
  }

  // Reads "int(11) unsigned", "varchar(80) binary", "double(16,4)",
  // "enum('a','b')" into a column definition.
  function parseColumnType(stream) {
    const word = stream.next();
    if (!word || word.type !== 'word') {
      stream.i--;
      throw stream.error();
    }
    let base = word.upper;
    if (base === 'DOUBLE' && stream.acceptWord('PRECISION')) {
      base = 'DOUBLE';
    }
    if (base === 'CHARACTER') {
      base = stream.acceptWord('VARYING') ? 'VARCHAR' : 'CHAR';
    }
    if (base === 'NATIONAL') {
      base = stream.next().upper;
    }
    if (base === 'BOOL' || base === 'BOOLEAN') {
      base = 'TINYINT';
    }
    if (!typeKind(base)) {
      stream.i--;
      throw stream.error();
    }
    const column = { base, length: null, decimals: null, values: null, unsigned: false, zerofill: false, binary: false };
    if (stream.acceptOp('(')) {
      if (base === 'ENUM' || base === 'SET') {
        column.values = [];
        do {
          const value = stream.next();
          if (!value || value.type !== 'string') {
            throw stream.error();
          }
          column.values.push(value.value);
        } while (stream.acceptOp(','));
      } else {
        column.length = parseInt(stream.next().value, 10);
        if (stream.acceptOp(',')) {
          column.decimals = parseInt(stream.next().value, 10);
        }
      }
      stream.expectOp(')');
    }
    for (;;) {
      if (stream.acceptWord('UNSIGNED')) {
        column.unsigned = true;
      } else if (stream.acceptWord('SIGNED')) {
        column.unsigned = false;
      } else if (stream.acceptWord('ZEROFILL')) {
        column.zerofill = true;
        column.unsigned = true;
      } else if (stream.acceptWord('BINARY')) {
        column.binary = true;
      } else {
        break;
      }
    }
    if (column.length === null) {
      if (INTEGER_TYPES[base]) {
        column.length = INTEGER_TYPES[base].width - (column.unsigned && base !== 'BIGINT' ? 1 : 0);
      } else if (base === 'CHAR') {
        column.length = 1;
      } else if (base === 'TIMESTAMP') {
        column.length = 14;
      }
    }
    return column;
  }

  // "int(11) unsigned", as SHOW COLUMNS prints it.
  function columnTypeText(column) {
    let text = column.base.toLowerCase();
    if (column.values) {
      text += `(${column.values.map(value => quoteString(value).replace(/\\/g, '\\\\')).join(',')})`;
    } else if (column.length !== null && !TEXT_TYPES[column.base] && !(DATE_TYPES[column.base] && column.base !== 'TIMESTAMP')) {
      text += `(${column.length}${column.decimals !== null ? `,${column.decimals}` : ''})`;
    }
    if (column.unsigned) {
      text += ' unsigned';
    }
    if (column.zerofill) {
      text += ' zerofill';
    }
    if (column.binary) {
      text += ' binary';
    }
    return text;
  }

  function implicitDefault(column) {
    const kind = typeKind(column.base);
    if (kind === 'integer' || kind === 'float') {
      return '0';
    }
    if (column.base === 'ENUM' && column.values.length) {
      return column.values[0];
    }
    if (column.base === 'DATE') {
      return '0000-00-00';
    }
    if (column.base === 'DATETIME') {
      return '0000-00-00 00:00:00';
    }
    if (column.base === 'TIME') {
      return '00:00:00';
    }
    if (column.base === 'YEAR') {
      return '0000';
    }
    if (column.base === 'TIMESTAMP') {
      return '00000000000000';
    }
    return '';
  }

  // The value MySQL's non-strict mode stores for a literal in this column.
  function coerceLiteral(column, value, table) {
    const kind = typeKind(column.base);
    if (value === null) {
      if (column.autoIncrement) {
        return null;
      }
      if (column.notNull) {
        return coerceLiteral(column, column.default !== null ? column.default : implicitDefault(column), table);
      }
      return null;
    }
    if (kind === 'integer') {
      const number = Math.trunc(leadingNumber(value));
      if (column.autoIncrement && number === 0) {
        return null;
      }
      const bits = INTEGER_TYPES[column.base].bits;
      const max = column.unsigned ? 2 ** bits - 1 : 2 ** (bits - 1) - 1;
      const min = column.unsigned ? 0 : -(2 ** (bits - 1));
      return Math.min(max, Math.max(min, number));
    }
    if (kind === 'float') {
      const number = leadingNumber(value);
      return column.unsigned && number < 0 ? 0 : number;
    }
    const text = typeof value === 'number' ? numberText(value) : String(value);
    const limit = column.base === 'CHAR' || column.base === 'VARCHAR' ? column.length : TEXT_TYPES[column.base];
    if (column.base === 'ENUM') {
      return column.values.includes(text) ? text : '';
    }
    return limit !== undefined && limit !== null && text.length > limit ? text.slice(0, limit) : text;
  }

  // MySQL reads the longest numeric prefix of a string, or 0.
  function leadingNumber(value) {
    if (typeof value === 'number') {
      return value;
    }
    const match = String(value).match(/^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    return match ? parseFloat(match[0]) : 0;
  }

  function numberText(number) {
    if (Number.isInteger(number)) {
      return BigInt(number).toString();
    }
    return String(number);
  }

  // ---------------------------------------------------------------------
  // Catalog: MySQL table definitions, kept in the database itself

  function sqliteColumnSql(column, inlinePrimaryKey) {
    const kind = typeKind(column.base);
    let type;
    if (kind === 'integer') {
      type = 'INTEGER';
    } else if (kind === 'float') {
      type = 'REAL';
    } else if (kind === 'blob') {
      type = 'BLOB';
    } else {
      type = 'TEXT';
    }
    let sql = `${quoteIdent(column.name)} ${type}`;
    if (inlinePrimaryKey) {
      return `${sql} PRIMARY KEY AUTOINCREMENT`;
    }
    // MySQL compares non-binary strings case-insensitively.
    if ((kind === 'text' || kind === 'date') && !column.binary) {
      sql += ' COLLATE NOCASE';
    }
    const defaultValue = column.default !== null ? column.default
      : (column.notNull && !column.autoIncrement ? implicitDefault(column) : null);
    if (defaultValue !== null) {
      const coerced = coerceLiteral({ ...column, autoIncrement: false }, defaultValue);
      sql += ` DEFAULT ${typeof coerced === 'number' ? numberText(coerced) : quoteString(coerced)}`;
    }
    return sql;
  }

  function usesRowid(definition, column) {
    return column.autoIncrement && definition.primaryKey.length === 1
      && definition.primaryKey[0].toLowerCase() === column.name.toLowerCase()
      && typeKind(column.base) === 'integer';
  }

  function createTableSql(definition, sqliteName = definition.name) {
    const parts = [];
    let inlined = false;
    for (const column of definition.columns) {
      const inline = usesRowid(definition, column);
      inlined = inlined || inline;
      parts.push(sqliteColumnSql(column, inline));
    }
    if (definition.primaryKey.length && !inlined) {
      parts.push(`PRIMARY KEY (${definition.primaryKey.map(quoteIdent).join(', ')})`);
    }
    return `CREATE TABLE ${quoteIdent(sqliteName)} (${parts.join(', ')})`;
  }

  function indexName(table, key) {
    return `${table}__${key}`;
  }

  function createIndexSql(definition, key) {
    return `CREATE ${key.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(indexName(definition.name, key.name))}`
      + ` ON ${quoteIdent(definition.name)} (${key.columns.map(quoteIdent).join(', ')})`;
  }

  function findColumn(definition, name) {
    const lower = String(name).toLowerCase();
    return definition.columns.find(column => column.name.toLowerCase() === lower) || null;
  }

  function fieldFlags(definition, column) {
    let flags = 0;
    const kind = typeKind(column.base);
    const lower = column.name.toLowerCase();
    if (column.notNull) {
      flags |= FLAG.NOT_NULL;
    }
    if (definition.primaryKey.some(name => name.toLowerCase() === lower)) {
      flags |= FLAG.PRI_KEY;
    }
    for (const key of definition.keys) {
      if (key.columns.some(name => name.toLowerCase() === lower)) {
        flags |= key.unique ? FLAG.UNIQUE_KEY : FLAG.MULTIPLE_KEY;
      }
    }
    if (kind === 'blob' || TEXT_TYPES[column.base]) {
      flags |= FLAG.BLOB;
    }
    if (column.unsigned) {
      flags |= FLAG.UNSIGNED;
    }
    if (column.zerofill) {
      flags |= FLAG.ZEROFILL;
    }
    if (kind === 'blob' || column.binary) {
      flags |= FLAG.BINARY;
    }
    if (column.base === 'ENUM') {
      flags |= FLAG.ENUM;
    }
    if (column.base === 'SET') {
      flags |= FLAG.SET;
    }
    if (column.autoIncrement) {
      flags |= FLAG.AUTO_INCREMENT;
    }
    if (column.base === 'TIMESTAMP') {
      flags |= FLAG.TIMESTAMP;
    }
    if (kind === 'integer' || kind === 'float') {
      flags |= FLAG.NUM;
    }
    return flags;
  }

  function fieldType(column) {
    if (INTEGER_TYPES[column.base]) {
      return INTEGER_TYPES[column.base].field;
    }
    if (FLOAT_TYPES[column.base]) {
      return FLOAT_TYPES[column.base].field;
    }
    if (DATE_TYPES[column.base]) {
      return DATE_TYPES[column.base].field;
    }
    if (TEXT_TYPES[column.base]) {
      return FIELD_TYPE.BLOB;
    }
    if (column.base === 'VARCHAR') {
      return FIELD_TYPE.VAR_STRING;
    }
    return FIELD_TYPE.STRING;
  }

  function fieldLength(column) {
    if (TEXT_TYPES[column.base]) {
      return TEXT_TYPES[column.base];
    }
    if (column.values) {
      return column.base === 'SET'
        ? column.values.join(',').length
        : Math.max(0, ...column.values.map(value => value.length));
    }
    if (FLOAT_TYPES[column.base] && column.length === null) {
      return FLOAT_TYPES[column.base].width;
    }
    if (DATE_TYPES[column.base] && column.base !== 'TIMESTAMP') {
      return DATE_TYPES[column.base].width;
    }
    return column.length || 0;
  }

  function columnField(definition, column, tableAlias) {
    return {
      name: column.name,
      table: tableAlias || definition.name,
      def: '',
      type: fieldType(column),
      length: fieldLength(column),
      flags: fieldFlags(definition, column),
      decimals: column.decimals || 0,
      column,
    };
  }

  // ---------------------------------------------------------------------
  // Values out: MySQL sends every value as text

  function latin1FromBytes(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return text;
  }

  function valueText(value, field) {
    if (value === null || value === undefined) {
      return null;
    }
    if (value instanceof Uint8Array) {
      return latin1FromBytes(value);
    }
    if (typeof value === 'number') {
      const column = field && field.column;
      if (column && column.decimals !== null && FLOAT_TYPES[column.base]) {
        return value.toFixed(column.decimals);
      }
      let text = numberText(value);
      if (column && column.zerofill && column.length) {
        text = text.padStart(column.length, '0');
      }
      return text;
    }
    return String(value);
  }

  // ---------------------------------------------------------------------
  // MySQL functions SQLite lacks

  function twoDigits(n) {
    return String(n).padStart(2, '0');
  }

  function formatDateTime(date) {
    return `${date.getUTCFullYear()}-${twoDigits(date.getUTCMonth() + 1)}-${twoDigits(date.getUTCDate())}`
      + ` ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}:${twoDigits(date.getUTCSeconds())}`;
  }

  // PASSWORD() as MySQL 3.23 computes it: the pre-4.1 16-digit hash.
  function oldPassword(text) {
    let nr = 1345345333;
    let add = 7;
    let nr2 = 0x12345671;
    for (const char of String(text)) {
      if (char === ' ' || char === '\t') {
        continue;
      }
      const tmp = char.charCodeAt(0) & 0xff;
      nr = (nr ^ ((((nr & 63) + add) * tmp) + (nr << 8) >>> 0)) >>> 0;
      nr2 = (nr2 + ((nr2 << 8) ^ nr)) >>> 0;
      add += tmp;
    }
    return ((nr & 0x7fffffff) >>> 0).toString(16).padStart(8, '0')
      + ((nr2 & 0x7fffffff) >>> 0).toString(16).padStart(8, '0');
  }

  // sql.js registers a function with its JS length as SQLite's argument
  // count. SQLite reads -1 as "any number", and a function's length is
  // configurable.
  function variadic(func) {
    Object.defineProperty(func, 'length', { value: -1 });
    return func;
  }

  function registerFunctions(db, now) {
    const anyNull = args => args.some(arg => arg === null);
    const text = value => (value instanceof Uint8Array ? latin1FromBytes(value) : String(value));
    db.create_function('MYSQL_CONCAT', variadic(function () {
      const args = Array.from(arguments);
      return anyNull(args) ? null : args.map(text).join('');
    }));
    db.create_function('MYSQL_CONCAT_WS', variadic(function () {
      const [separator, ...args] = Array.from(arguments);
      return separator === null ? null : args.filter(arg => arg !== null).map(text).join(text(separator));
    }));
    db.create_function('NOW', () => formatDateTime(new Date(now())));
    db.create_function('SYSDATE', () => formatDateTime(new Date(now())));
    db.create_function('CURDATE', () => formatDateTime(new Date(now())).slice(0, 10));
    db.create_function('CURTIME', () => formatDateTime(new Date(now())).slice(11));
    db.create_function('UNIX_TIMESTAMP', variadic(function () {
      if (!arguments.length) {
        return Math.floor(now() / 1000);
      }
      const parsed = Date.parse(`${text(arguments[0]).replace(' ', 'T')}Z`);
      return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
    }));
    db.create_function('FROM_UNIXTIME', value => (value === null ? null : formatDateTime(new Date(value * 1000))));
    db.create_function('RAND', () => Math.random());
    db.create_function('LCASE', value => (value === null ? null : text(value).toLowerCase()));
    db.create_function('UCASE', value => (value === null ? null : text(value).toUpperCase()));
    db.create_function('LEFT', (value, length) => (value === null || length === null ? null : text(value).slice(0, Math.max(0, length))));
    db.create_function('RIGHT', (value, length) => (value === null || length === null ? null : (length > 0 ? text(value).slice(-length) : '')));
    db.create_function('MID', (value, position, length) => (value === null ? null : text(value).substr(position - 1, length)));
    db.create_function('CHAR_LENGTH', value => (value === null ? null : text(value).length));
    db.create_function('LOCATE', variadic(function () {
      const [needle, haystack, start = 1] = Array.from(arguments);
      return needle === null || haystack === null ? null : text(haystack).indexOf(text(needle), start - 1) + 1;
    }));
    db.create_function('FIND_IN_SET', (needle, list) => {
      if (needle === null || list === null) {
        return null;
      }
      return text(list).split(',').indexOf(text(needle)) + 1;
    });
    db.create_function('GREATEST', variadic(function () {
      const args = Array.from(arguments);
      return anyNull(args) ? null : args.reduce((a, b) => (b > a ? b : a));
    }));
    db.create_function('LEAST', variadic(function () {
      const args = Array.from(arguments);
      return anyNull(args) ? null : args.reduce((a, b) => (b < a ? b : a));
    }));
    db.create_function('PASSWORD', value => (value === null ? null : oldPassword(text(value))));
    // SQLite calls regexp(pattern, subject) for "subject REGEXP pattern".
    db.create_function('REGEXP', (pattern, subject) => (pattern === null || subject === null ? null
      : (new RegExp(text(pattern), 'i').test(text(subject)) ? 1 : 0)));
  }

  function likePattern(pattern) {
    let regex = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '\\' && i + 1 < pattern.length) {
        regex += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      } else if (c === '%') {
        regex += '.*';
      } else if (c === '_') {
        regex += '.';
      } else {
        regex += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    return new RegExp(`^${regex}$`, 'i');
  }

  // ---------------------------------------------------------------------
  // The server

  class MysqlOnSqlite {
    // SQL: an initialized sql.js module. Options:
    //   users: { name: password } to check logins; omitted, any login works
    //   now: () => milliseconds, the clock behind NOW() and UNIX_TIMESTAMP()
    constructor(SQL, { serverVersion = '3.23.49', users = null, now = () => Date.now() } = {}) {
      this.SQL = SQL;
      this.serverVersion = serverVersion;
      this.users = users;
      this.now = now;
      this.databases = new Map();
      this.links = new Map();
      this.nextLink = 1;
      this.writes = 0;
    }

    // Opens a database from an exported SQLite file, or a new empty one.
    addDatabase(name, bytes = null) {
      if (this.databases.has(name)) {
        throw new Error(`Database ${name} exists`);
      }
      const db = bytes ? new this.SQL.Database(bytes) : new this.SQL.Database();
      db.exec(`CREATE TABLE IF NOT EXISTS ${quoteIdent(CATALOG)} (name TEXT PRIMARY KEY, definition TEXT NOT NULL)`);
      registerFunctions(db, this.now);
      this.databases.set(name, { db, definitions: new Map() });
    }

    exportDatabase(name) {
      const entry = this.databases.get(name);
      if (!entry) {
        throw new Error(`No database ${name}`);
      }
      return entry.db.export();
    }

    // The entry point for libmysql.c, through php-runtime.js. Arguments are
    // ISO-8859-1 strings or null. Returns a response object.
    handle(op, linkId, a, b, c) {
      try {
        switch (op) {
          case 1:
            return this.connect(a, b, c);
          case 2:
            this.links.delete(linkId);
            return { kind: 'ok', affectedRows: 0, insertId: 0 };
          case 3:
            this.selectDatabase(this.link(linkId), a);
            return { kind: 'ok', affectedRows: 0, insertId: 0 };
          case 4: {
            const response = this.query(this.link(linkId), a);
            // A statement that answered without rows may have written.
            if (response.kind === 'ok') {
              this.writes++;
            }
            return response;
          }
          case 5:
            return this.listFields(this.link(linkId), a, b);
          case 6:
            this.link(linkId);
            return { kind: 'ok', affectedRows: 0, insertId: 0 };
          default:
            throw new MysqlError(ER.UNKNOWN, `Unknown command ${op}`);
        }
      } catch (error) {
        if (error instanceof MysqlError) {
          return { kind: 'error', errno: error.errno, message: error.message };
        }
        return { kind: 'error', ...this.sqliteError(error) };
      }
    }

    connect(host, user, password) {
      const name = user || '';
      if (this.users && this.users[name] !== (password || '')) {
        throw new MysqlError(ER.ACCESS_DENIED,
          `Access denied for user: '${name}@${host || 'localhost'}' (Using password: ${password ? 'YES' : 'NO'})`);
      }
      const id = this.nextLink++;
      this.links.set(id, { database: null, host: host || 'localhost' });
      return { kind: 'link', link: id, serverVersion: this.serverVersion, hostInfo: `${host || 'localhost'} via SQLite in WebAssembly` };
    }

    link(id) {
      const link = this.links.get(id);
      if (!link) {
        throw new MysqlError(2013, 'Lost connection to MySQL server during query');
      }
      return link;
    }

    selectDatabase(link, name) {
      if (!this.databases.has(name)) {
        throw new MysqlError(ER.BAD_DB, `Unknown database '${name}'`);
      }
      link.database = name;
    }

    database(link) {
      if (!link.database) {
        throw new MysqlError(ER.NO_DB, 'No Database Selected');
      }
      return this.databases.get(link.database);
    }

    definition(entry, table, required = true) {
      if (entry.definitions.has(table)) {
        return entry.definitions.get(table);
      }
      const statement = entry.db.prepare(`SELECT definition FROM ${quoteIdent(CATALOG)} WHERE name = ?`);
      let definition = null;
      try {
        statement.bind([table]);
        if (statement.step()) {
          definition = JSON.parse(statement.get()[0]);
        }
      } finally {
        statement.free();
      }
      if (!definition && required) {
        throw new MysqlError(ER.NO_SUCH_TABLE, `Table '${this.currentName(entry)}.${table}' doesn't exist`);
      }
      if (definition) {
        entry.definitions.set(table, definition);
      }
      return definition;
    }

    currentName(entry) {
      for (const [name, candidate] of this.databases) {
        if (candidate === entry) {
          return name;
        }
      }
      return '';
    }

    saveDefinition(entry, definition) {
      entry.db.run(`INSERT OR REPLACE INTO ${quoteIdent(CATALOG)} (name, definition) VALUES (?, ?)`,
        [definition.name, JSON.stringify(definition)]);
      entry.definitions.set(definition.name, definition);
    }

    dropDefinition(entry, table) {
      entry.db.run(`DELETE FROM ${quoteIdent(CATALOG)} WHERE name = ?`, [table]);
      entry.definitions.delete(table);
    }

    tableNames(entry) {
      return entry.db.exec(`SELECT name FROM ${quoteIdent(CATALOG)} ORDER BY name`)
        .flatMap(result => result.values.map(row => row[0]));
    }

    query(link, sql) {
      const tokens = tokenize(sql);
      while (tokens.length && tokens[tokens.length - 1].type === 'op' && tokens[tokens.length - 1].value === ';') {
        tokens.pop();
      }
      if (!tokens.length) {
        throw new MysqlError(ER.EMPTY_QUERY, 'Query was empty');
      }
      const stream = new TokenStream(tokens, sql);
      const first = stream.peek();
      if (first.type !== 'word') {
        throw stream.error();
      }
      switch (first.upper) {
        case 'SELECT':
          return this.select(link, stream);
        case 'INSERT':
        case 'REPLACE':
          return this.insert(link, stream);
        case 'UPDATE':
          return this.update(link, stream);
        case 'DELETE':
          return this.delete(link, stream);
        case 'CREATE':
          return this.create(link, stream);
        case 'DROP':
          return this.drop(link, stream);
        case 'ALTER':
          return this.alter(link, stream);
        case 'SHOW':
          return this.show(link, stream);
        case 'DESCRIBE':
        case 'DESC':
          stream.next();
          return this.showColumns(link, stream.name(), null);
        case 'USE':
          stream.next();
          this.selectDatabase(link, stream.name());
          return this.ok();
        case 'TRUNCATE':
          return this.truncate(link, stream);
        case 'OPTIMIZE':
        case 'ANALYZE':
        case 'CHECK':
        case 'REPAIR':
          return this.maintenance(link, stream);
        case 'SET':
        case 'LOCK':
        case 'UNLOCK':
        case 'FLUSH':
        case 'GRANT':
        case 'REVOKE':
          return this.ok();
        default:
          throw stream.error();
      }
    }

    ok(affectedRows = 0, insertId = 0) {
      return { kind: 'ok', affectedRows, insertId };
    }

    result(fields, rows) {
      const lengths = fields.map(() => 0);
      const textRows = rows.map(row => row.map((value, i) => {
        const text = valueText(value, fields[i]);
        if (text !== null && text.length > lengths[i]) {
          lengths[i] = text.length;
        }
        return text;
      }));
      return {
        kind: 'result',
        fields: fields.map((field, i) => ({
          name: field.name,
          table: field.table || '',
          def: field.def || '',
          type: field.type,
          length: field.length,
          maxLength: lengths[i],
          flags: field.flags || 0,
          decimals: field.decimals || 0,
        })),
        rows: textRows,
      };
    }

    // A result whose columns are all strings, for SHOW and friends.
    textResult(names, rows, table = '') {
      return this.result(names.map(name => ({
        name, table, type: FIELD_TYPE.VAR_STRING, length: 64, flags: 0,
      })), rows);
    }

    run(entry, sql, params) {
      entry.db.run(sql, params);
      return entry.db.getRowsModified();
    }

    lastInsertRowid(entry) {
      return entry.db.exec('SELECT last_insert_rowid()')[0].values[0][0];
    }

    // --- SELECT ---------------------------------------------------------

    select(link, stream) {
      const entry = link.database ? this.databases.get(link.database) : null;
      const tokens = stream.tokens;
      stream.next();
      while (stream.acceptWord('DISTINCTROW', 'HIGH_PRIORITY', 'STRAIGHT_JOIN', 'SQL_SMALL_RESULT',
        'SQL_BIG_RESULT', 'SQL_BUFFER_RESULT', 'SQL_CACHE', 'SQL_NO_CACHE', 'SQL_CALC_FOUND_ROWS')) {
        // Hints with no SQLite meaning.
      }
      const distinct = stream.acceptWord('DISTINCT');
      const listStart = stream.i;
      const list = stream.until(['FROM'], [';']);
      const items = splitTopLevel(list);
      let rest = tokens.slice(stream.i);

      if (rest.length >= 2 && rest[0].upper === 'FROM' && rest[1].upper === 'DUAL') {
        rest = rest.slice(2);
      } else if (!entry && rest.length && rest[0].upper === 'FROM') {
        // Only a SELECT without tables runs before a database is selected.
        throw new MysqlError(ER.NO_DB, 'No Database Selected');
      }
      const sources = entry && stream.acceptWord('FROM') ? this.fromTables(entry, stream) : [];

      // MySQL names an unaliased expression column by its text as written.
      const emittedItems = items.map(item => {
        const last = item[item.length - 1];
        const hasAlias = item.length >= 2 && (isNameToken(last) || last.type === 'string')
          && (item[item.length - 2].upper === 'AS' || !(item[item.length - 2].type === 'op'));
        const simple = (item.length === 1 && (isNameToken(item[0]) || (item[0].type === 'op' && item[0].value === '*')))
          || (item.length === 3 && isNameToken(item[0]) && item[1].value === '.' && (isNameToken(item[2]) || item[2].value === '*'));
        if (hasAlias && item.length > 1 && item[item.length - 2].upper !== 'AS' && last.type === 'string') {
          return `${emit(item.slice(0, -1))} AS ${quoteIdent(last.value)}`;
        }
        if (hasAlias && last.type === 'string') {
          return `${emit(item.slice(0, -1))} ${quoteIdent(last.value)}`;
        }
        if (hasAlias || simple) {
          return emit(item);
        }
        const original = stream.sql.slice(item[0].start, last.end);
        return `${emit(item)} AS ${quoteIdent(original)}`;
      });
      const sqliteSql = `SELECT ${distinct ? 'DISTINCT ' : ''}${emittedItems.join(', ')} ${emit(rest)}`.trim();
      if (listStart === stream.tokens.length) {
        throw stream.error();
      }

      const db = entry ? entry.db : this.scratchDatabase();
      const statement = db.prepare(sqliteSql);
      const rows = [];
      let names;
      try {
        names = statement.getColumnNames();
        while (statement.step()) {
          rows.push(statement.get());
        }
      } finally {
        statement.free();
      }
      const fields = this.resultFields(names, items, sources, rows);
      return this.result(fields, rows);
    }

    scratchDatabase() {
      if (!this.scratch) {
        this.scratch = new this.SQL.Database();
        registerFunctions(this.scratch, this.now);
      }
      return this.scratch;
    }

    // [{ alias, definition }] for the tables a FROM clause names.
    fromTables(entry, stream) {
      const sources = [];
      const clause = stream.until(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'PROCEDURE', 'INTO', 'FOR', 'LOCK'], [';']);
      const inner = new TokenStream(clause, stream.sql);
      while (!inner.atEnd()) {
        if (isNameToken(inner.peek())) {
          const table = inner.name();
          let alias = table;
          if (inner.acceptWord('AS')) {
            alias = inner.name();
          } else if (isNameToken(inner.peek()) && !inner.isWord('LEFT', 'RIGHT', 'INNER', 'CROSS', 'JOIN',
            'STRAIGHT_JOIN', 'NATURAL', 'ON', 'USING', 'OUTER', 'USE', 'IGNORE', 'FORCE')) {
            alias = inner.name();
          }
          const definition = this.definition(entry, table, false);
          if (definition) {
            sources.push({ alias, definition });
          }
        }
        // Skip to the next table reference.
        while (!inner.atEnd() && !(inner.isOp(',') || inner.isWord('JOIN', 'STRAIGHT_JOIN'))) {
          if (inner.isOp('(')) {
            inner.next();
            inner.until();
          }
          inner.next();
        }
        inner.next();
      }
      return sources;
    }

    // Field metadata for each result column: the table column it reads when
    // that can be told, else a type inferred from the values.
    resultFields(names, items, sources, rows) {
      const expansion = [];
      for (const item of items) {
        if (item.length === 1 && item[0].type === 'op' && item[0].value === '*') {
          for (const source of sources) {
            for (const column of source.definition.columns) {
              expansion.push({ source, column });
            }
          }
        } else if (item.length === 3 && isNameToken(item[0]) && item[1].value === '.' && item[2].value === '*') {
          const source = sources.find(candidate => candidate.alias === item[0].value);
          for (const column of source ? source.definition.columns : []) {
            expansion.push({ source, column });
          }
        } else if (item.length === 3 && isNameToken(item[0]) && item[1].value === '.' && isNameToken(item[2])) {
          const source = sources.find(candidate => candidate.alias === item[0].value);
          const column = source ? findColumn(source.definition, item[2].value) : null;
          expansion.push(column ? { source, column } : null);
        } else if (item.length === 1 && isNameToken(item[0])) {
          const matches = sources.map(source => ({ source, column: findColumn(source.definition, item[0].value) }))
            .filter(match => match.column);
          expansion.push(matches[0] || null);
        } else {
          expansion.push(null);
        }
      }
      const positional = expansion.length === names.length;
      return names.map((name, i) => {
        const match = positional ? expansion[i] : null;
        if (match) {
          return { ...columnField(match.source.definition, match.column, match.source.alias), name };
        }
        return this.inferredField(name, rows.map(row => row[i]));
      });
    }

    inferredField(name, values) {
      const present = values.filter(value => value !== null && value !== undefined);
      if (present.length && present.every(value => typeof value === 'number' && Number.isInteger(value))) {
        return { name, table: '', type: /^count\s*\(/i.test(name) ? FIELD_TYPE.LONGLONG : FIELD_TYPE.LONG, length: 21, flags: FLAG.NUM };
      }
      if (present.length && present.every(value => typeof value === 'number')) {
        return { name, table: '', type: FIELD_TYPE.DOUBLE, length: 22, flags: FLAG.NUM, decimals: 31 };
      }
      return { name, table: '', type: FIELD_TYPE.VAR_STRING, length: Math.max(0, ...present.map(value => valueText(value).length)) };
    }

    // --- INSERT / REPLACE -------------------------------------------------

    literal(tokens) {
      if (tokens.length === 1) {
        const [token] = tokens;
        if (token.type === 'string') {
          return { value: token.value };
        }
        if (token.type === 'number') {
          return { value: /^0x/i.test(token.value) ? parseInt(token.value, 16) : Number(token.value) };
        }
        if (token.type === 'word' && token.upper === 'NULL') {
          return { value: null };
        }
      }
      if (tokens.length === 2 && tokens[0].type === 'op' && (tokens[0].value === '-' || tokens[0].value === '+')
          && tokens[1].type === 'number') {
        const number = Number(tokens[1].value);
        return { value: tokens[0].value === '-' ? -number : number };
      }
      return null;
    }

    bindValue(column, tokens, params) {
      const literal = this.literal(tokens);
      if (!literal || !column) {
        return emit(tokens);
      }
      params.push(coerceLiteral(column, literal.value));
      return '?';
    }

    insert(link, stream) {
      const entry = this.database(link);
      const replace = stream.next().upper === 'REPLACE';
      let ignore = false;
      while (stream.isWord('LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY', 'IGNORE')) {
        ignore = stream.next().upper === 'IGNORE' || ignore;
      }
      stream.acceptWord('INTO');
      const table = stream.name();
      const definition = this.definition(entry, table);
      const verb = replace ? 'INSERT OR REPLACE' : (ignore ? 'INSERT OR IGNORE' : 'INSERT');
      let columns = null;
      if (stream.isOp('(') && !(stream.peek(1) && stream.peek(1).upper === 'SELECT')) {
        stream.next();
        columns = [];
        do {
          columns.push(stream.name());
        } while (stream.acceptOp(','));
        stream.expectOp(')');
      }

      let rows;
      if (stream.acceptWord('SET')) {
        columns = [];
        const values = [];
        for (const assignment of splitTopLevel(stream.until())) {
          if (assignment.length < 3 || !isNameToken(assignment[0]) || assignment[1].value !== '=') {
            throw syntaxError(stream.sql, assignment[0] ? assignment[0].start : stream.sql.length);
          }
          columns.push(assignment[0].value);
          values.push(assignment.slice(2));
        }
        rows = [values];
      } else if (stream.acceptWord('VALUES', 'VALUE')) {
        rows = [];
        do {
          stream.expectOp('(');
          rows.push(splitTopLevel(stream.until()));
          stream.expectOp(')');
        } while (stream.acceptOp(','));
      } else if (stream.isWord('SELECT') || stream.isOp('(')) {
        const target = columns ? ` (${columns.map(quoteIdent).join(', ')})` : '';
        const modified = this.run(entry, `${verb} INTO ${quoteIdent(table)}${target} ${emit(stream.tokens.slice(stream.i))}`);
        return this.ok(modified, 0);
      } else {
        throw stream.error();
      }
      if (!stream.atEnd()) {
        throw stream.error();
      }

      const targetColumns = (columns || definition.columns.map(column => column.name)).map(name => {
        const column = findColumn(definition, name);
        if (!column) {
          throw new MysqlError(ER.BAD_FIELD, `Unknown column '${name}' in 'field list'`);
        }
        return column;
      });
      const autoIncrement = definition.columns.find(column => column.autoIncrement) || null;
      const generated = autoIncrement && !usesRowid(definition, autoIncrement);
      let insertId = 0;
      let affected = 0;
      for (const row of rows) {
        if (row.length !== targetColumns.length) {
          throw new MysqlError(1136, "Column count doesn't match value count at row 1");
        }
        const params = [];
        const names = targetColumns.map(column => column.name);
        const placeholders = row.map((value, i) => this.bindValue(targetColumns[i], value, params));
        // An auto_increment column SQLite cannot number itself: MAX + 1.
        if (generated) {
          const position = names.findIndex(name => name.toLowerCase() === autoIncrement.name.toLowerCase());
          const paramIndex = position < 0 ? -1 : placeholders.slice(0, position + 1).filter(p => p === '?').length - 1;
          if (position < 0 || (placeholders[position] === '?' && params[paramIndex] === null)) {
            const next = entry.db.exec(`SELECT IFNULL(MAX(${quoteIdent(autoIncrement.name)}), 0) + 1 FROM ${quoteIdent(table)}`)[0].values[0][0];
            if (position < 0) {
              names.push(autoIncrement.name);
              placeholders.push('?');
              params.push(next);
            } else {
              params[paramIndex] = next;
            }
            insertId = next;
          }
        }
        affected += this.run(entry,
          `${verb} INTO ${quoteIdent(table)} (${names.map(quoteIdent).join(', ')}) VALUES (${placeholders.join(', ')})`, params);
        if (autoIncrement && !generated) {
          insertId = this.lastInsertRowid(entry);
        }
      }
      return this.ok(affected, insertId);
    }

    // --- UPDATE / DELETE --------------------------------------------------

    // ORDER BY and LIMIT on UPDATE and DELETE, which SQLite's default build
    // lacks, become a rowid subquery.
    limitedWhere(table, stream) {
      const where = stream.acceptWord('WHERE') ? stream.until(['ORDER', 'LIMIT']) : [];
      const order = stream.acceptWord('ORDER') ? (stream.expectWord('BY'), stream.until(['LIMIT'])) : null;
      const limit = stream.acceptWord('LIMIT') ? stream.until() : null;
      if (!stream.atEnd()) {
        throw stream.error();
      }
      if (!order && !limit) {
        return where.length ? ` WHERE ${emit(where)}` : '';
      }
      return ` WHERE rowid IN (SELECT rowid FROM ${quoteIdent(table)}${where.length ? ` WHERE ${emit(where)}` : ''}`
        + `${order ? ` ORDER BY ${emit(order)}` : ''}${limit ? ` LIMIT ${emit(limit)}` : ''})`;
    }

    update(link, stream) {
      const entry = this.database(link);
      stream.next();
      let ignore = false;
      while (stream.isWord('LOW_PRIORITY', 'IGNORE')) {
        ignore = stream.next().upper === 'IGNORE' || ignore;
      }
      const table = stream.name();
      const definition = this.definition(entry, table);
      stream.expectWord('SET');
      const params = [];
      const assignments = splitTopLevel(stream.until(['WHERE', 'ORDER', 'LIMIT'])).map(assignment => {
        let nameTokens = 1;
        if (assignment.length > 3 && assignment[1].value === '.') {
          nameTokens = 3;
        }
        if (assignment.length < nameTokens + 2 || assignment[nameTokens].value !== '=') {
          throw syntaxError(stream.sql, assignment[0] ? assignment[0].start : stream.sql.length);
        }
        const name = assignment[nameTokens - 1].value;
        const column = findColumn(definition, name);
        if (!column) {
          throw new MysqlError(ER.BAD_FIELD, `Unknown column '${name}' in 'field list'`);
        }
        return `${quoteIdent(column.name)} = ${this.bindValue(column, assignment.slice(nameTokens + 1), params)}`;
      });
      const where = this.limitedWhere(table, stream);
      const sql = `UPDATE ${ignore ? 'OR IGNORE ' : ''}${quoteIdent(table)} SET ${assignments.join(', ')}${where}`;
      return this.ok(this.run(entry, sql, params));
    }

    delete(link, stream) {
      const entry = this.database(link);
      stream.next();
      while (stream.acceptWord('LOW_PRIORITY', 'QUICK', 'IGNORE')) {
        // No SQLite meaning.
      }
      stream.expectWord('FROM');
      const table = stream.name();
      this.definition(entry, table);
      return this.ok(this.run(entry, `DELETE FROM ${quoteIdent(table)}${this.limitedWhere(table, stream)}`));
    }

    truncate(link, stream) {
      const entry = this.database(link);
      stream.next();
      stream.acceptWord('TABLE');
      const table = stream.name();
      this.definition(entry, table);
      this.run(entry, `DELETE FROM ${quoteIdent(table)}`);
      if (entry.db.exec("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").length) {
        this.run(entry, 'DELETE FROM sqlite_sequence WHERE name = ?', [table]);
      }
      return this.ok();
    }

    // --- CREATE / DROP / ALTER ------------------------------------------

    create(link, stream) {
      stream.next();
      if (stream.acceptWord('DATABASE', 'SCHEMA')) {
        const ifNotExists = Boolean(stream.acceptWord('IF') && stream.expectWord('NOT') && stream.expectWord('EXISTS'));
        const name = stream.name();
        if (this.databases.has(name)) {
          if (ifNotExists) {
            return this.ok();
          }
          throw new MysqlError(ER.DB_CREATE_EXISTS, `Can't create database '${name}'. Database exists`);
        }
        this.addDatabase(name);
        return this.ok(1);
      }
      const unique = Boolean(stream.acceptWord('UNIQUE'));
      if (stream.acceptWord('INDEX')) {
        const entry = this.database(link);
        const name = stream.name();
        stream.expectWord('ON');
        const table = stream.name();
        const definition = JSON.parse(JSON.stringify(this.definition(entry, table)));
        const key = { name, unique, columns: this.keyColumns(stream) };
        definition.keys.push(key);
        this.rebuild(entry, definition, definition);
        return this.ok();
      }
      stream.acceptWord('TEMPORARY');
      stream.expectWord('TABLE');
      const entry = this.database(link);
      const ifNotExists = Boolean(stream.acceptWord('IF') && stream.expectWord('NOT') && stream.expectWord('EXISTS'));
      const name = stream.name();
      if (this.definition(entry, name, false)) {
        if (ifNotExists) {
          return this.ok();
        }
        throw new MysqlError(ER.TABLE_EXISTS, `Table '${name}' already exists`);
      }
      const definition = { name, columns: [], primaryKey: [], keys: [] };
      stream.expectOp('(');
      do {
        this.createDefinition(stream, definition);
      } while (stream.acceptOp(','));
      stream.expectOp(')');
      const options = stream.until();
      for (let i = 0; i < options.length; i++) {
        if (options[i].upper === 'AUTO_INCREMENT' && options[i + 1] && options[i + 1].value === '=' && options[i + 2]) {
          definition.autoIncrementStart = Number(options[i + 2].value);
        }
      }
      this.createTable(entry, definition);
      return this.ok();
    }

    keyColumns(stream) {
      const columns = [];
      stream.expectOp('(');
      do {
        columns.push(stream.name());
        if (stream.acceptOp('(')) {
          // A prefix length, as in KEY title (title(20)).
          stream.until();
          stream.expectOp(')');
        }
        stream.acceptWord('ASC', 'DESC');
      } while (stream.acceptOp(','));
      stream.expectOp(')');
      return columns;
    }

    // One item of CREATE TABLE's list: a column, or a key.
    createDefinition(stream, definition) {
      if (stream.acceptWord('PRIMARY')) {
        stream.expectWord('KEY');
        if (isNameToken(stream.peek())) {
          stream.name();
        }
        definition.primaryKey = this.keyColumns(stream);
        return;
      }
      if (stream.isWord('KEY', 'INDEX', 'UNIQUE', 'FULLTEXT')) {
        const kind = stream.next().upper;
        if (kind === 'UNIQUE' || kind === 'FULLTEXT') {
          stream.acceptWord('KEY', 'INDEX');
        }
        const name = isNameToken(stream.peek()) ? stream.name() : null;
        const columns = this.keyColumns(stream);
        if (kind !== 'FULLTEXT') {
          definition.keys.push({ name: name || this.keyName(definition, columns[0]), unique: kind === 'UNIQUE', columns });
        }
        return;
      }
      if (stream.acceptWord('CHECK')) {
        stream.expectOp('(');
        stream.until();
        stream.expectOp(')');
        return;
      }
      definition.columns.push(this.columnDefinition(stream, definition));
    }

    keyName(definition, column) {
      let name = column;
      let n = 2;
      while (definition.keys.some(key => key.name === name)) {
        name = `${column}_${n++}`;
      }
      return name;
    }

    columnDefinition(stream, definition) {
      const name = stream.name();
      const column = { name, ...parseColumnType(stream), notNull: false, default: null, autoIncrement: false };
      for (;;) {
        if (stream.acceptWord('NOT')) {
          stream.expectWord('NULL');
          column.notNull = true;
        } else if (stream.acceptWord('NULL')) {
          column.notNull = false;
        } else if (stream.acceptWord('DEFAULT')) {
          const tokens = stream.peek() && stream.peek().type === 'op' ? [stream.next(), stream.next()] : [stream.next()];
          const literal = this.literal(tokens);
          if (!literal) {
            throw syntaxError(stream.sql, tokens[0].start);
          }
          column.default = literal.value === null ? null : (typeof literal.value === 'number' ? numberText(literal.value) : literal.value);
        } else if (stream.acceptWord('AUTO_INCREMENT')) {
          column.autoIncrement = true;
        } else if (stream.acceptWord('PRIMARY')) {
          stream.expectWord('KEY');
          definition.primaryKey = [name];
        } else if (stream.acceptWord('UNIQUE')) {
          stream.acceptWord('KEY');
          definition.keys.push({ name: this.keyName(definition, name), unique: true, columns: [name] });
        } else if (stream.acceptWord('KEY')) {
          definition.primaryKey = [name];
        } else if (stream.acceptWord('COMMENT')) {
          stream.next();
        } else {
          break;
        }
      }
      // MySQL makes an auto_increment column NOT NULL, and ignores its DEFAULT.
      if (column.autoIncrement) {
        column.notNull = true;
        column.default = null;
      }
      return column;
    }

    createTable(entry, definition) {
      entry.db.run(createTableSql(definition));
      for (const key of definition.keys) {
        entry.db.run(createIndexSql(definition, key));
      }
      if (definition.autoIncrementStart > 1) {
        entry.db.run('INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES (?, ?)',
          [definition.name, definition.autoIncrementStart - 1]);
      }
      this.saveDefinition(entry, definition);
    }

    drop(link, stream) {
      stream.next();
      if (stream.acceptWord('DATABASE', 'SCHEMA')) {
        const ifExists = Boolean(stream.acceptWord('IF') && stream.expectWord('EXISTS'));
        const name = stream.name();
        if (!this.databases.has(name)) {
          if (ifExists) {
            return this.ok();
          }
          throw new MysqlError(ER.DB_DROP_EXISTS, `Can't drop database '${name}'. Database doesn't exist`);
        }
        const tables = this.tableNames(this.databases.get(name)).length;
        this.databases.get(name).db.close();
        this.databases.delete(name);
        for (const other of this.links.values()) {
          if (other.database === name) {
            other.database = null;
          }
        }
        return this.ok(tables);
      }
      const entry = this.database(link);
      if (stream.acceptWord('INDEX')) {
        const name = stream.name();
        stream.expectWord('ON');
        const table = stream.name();
        return this.alterTable(entry, table, definition => this.dropKey(definition, name));
      }
      stream.acceptWord('TEMPORARY');
      stream.expectWord('TABLE');
      const ifExists = Boolean(stream.acceptWord('IF') && stream.expectWord('EXISTS'));
      const tables = [];
      do {
        tables.push(stream.name());
      } while (stream.acceptOp(','));
      stream.acceptWord('RESTRICT', 'CASCADE');
      const missing = tables.filter(table => !this.definition(entry, table, false));
      if (missing.length && !ifExists) {
        throw new MysqlError(ER.BAD_TABLE, `Unknown table '${missing.join(',')}'`);
      }
      for (const table of tables.filter(name => !missing.includes(name))) {
        entry.db.run(`DROP TABLE ${quoteIdent(table)}`);
        this.dropDefinition(entry, table);
      }
      return this.ok();
    }

    dropKey(definition, name) {
      if (name.toUpperCase() === 'PRIMARY') {
        definition.primaryKey = [];
        return;
      }
      const index = definition.keys.findIndex(key => key.name.toLowerCase() === name.toLowerCase());
      if (index < 0) {
        throw new MysqlError(ER.KEY_DOES_NOT_EXIST, `Can't DROP '${name}'. Check that column/key exists`);
      }
      definition.keys.splice(index, 1);
    }

    alter(link, stream) {
      const entry = this.database(link);
      stream.next();
      stream.acceptWord('IGNORE');
      stream.expectWord('TABLE');
      const table = stream.name();
      return this.alterTable(entry, table, definition => {
        do {
          this.alterSpecification(stream, definition);
        } while (stream.acceptOp(','));
        if (!stream.atEnd()) {
          throw stream.error();
        }
      });
    }

    // Applies changes to a copy of the definition, then rebuilds the table:
    // SQLite's own ALTER TABLE cannot change a column.
    alterTable(entry, table, change) {
      const before = this.definition(entry, table);
      const after = JSON.parse(JSON.stringify(before));
      after.renamedFrom = {};
      change(after);
      const renamedFrom = after.renamedFrom;
      delete after.renamedFrom;
      this.rebuild(entry, before, after, renamedFrom);
      return this.ok();
    }

    alterSpecification(stream, definition) {
      const position = column => {
        if (stream.acceptWord('FIRST')) {
          return 0;
        }
        if (stream.acceptWord('AFTER')) {
          const after = stream.name();
          const index = definition.columns.findIndex(candidate => candidate.name.toLowerCase() === after.toLowerCase());
          if (index < 0) {
            throw new MysqlError(ER.BAD_FIELD, `Unknown column '${after}' in '${definition.name}'`);
          }
          return index + 1;
        }
        return definition.columns.length;
      };
      if (stream.acceptWord('ADD')) {
        if (stream.isWord('PRIMARY', 'KEY', 'INDEX', 'UNIQUE', 'FULLTEXT')) {
          this.createDefinition(stream, definition);
          return;
        }
        stream.acceptWord('COLUMN');
        if (stream.acceptOp('(')) {
          do {
            definition.columns.push(this.columnDefinition(stream, definition));
          } while (stream.acceptOp(','));
          stream.expectOp(')');
          return;
        }
        const column = this.columnDefinition(stream, definition);
        if (findColumn(definition, column.name)) {
          throw new MysqlError(1060, `Duplicate column name '${column.name}'`);
        }
        definition.columns.splice(position(column), 0, column);
        return;
      }
      if (stream.acceptWord('CHANGE', 'MODIFY')) {
        const modify = stream.tokens[stream.i - 1].upper === 'MODIFY';
        stream.acceptWord('COLUMN');
        const oldName = modify ? stream.peek().value : stream.name();
        const index = definition.columns.findIndex(candidate => candidate.name.toLowerCase() === oldName.toLowerCase());
        if (index < 0) {
          throw new MysqlError(ER.BAD_FIELD, `Unknown column '${oldName}' in '${definition.name}'`);
        }
        const column = this.columnDefinition(stream, definition);
        const old = definition.columns[index];
        definition.columns.splice(index, 1);
        definition.renamedFrom[column.name] = definition.renamedFrom[old.name] || old.name;
        const at = stream.isWord('FIRST', 'AFTER') ? position(column) : index;
        definition.columns.splice(at, 0, column);
        if (column.name !== old.name) {
          const rename = name => (name.toLowerCase() === old.name.toLowerCase() ? column.name : name);
          definition.primaryKey = definition.primaryKey.map(rename);
          for (const key of definition.keys) {
            key.columns = key.columns.map(rename);
          }
        }
        return;
      }
      if (stream.acceptWord('ALTER')) {
        stream.acceptWord('COLUMN');
        const column = findColumn(definition, stream.name());
        if (!column) {
          throw stream.error();
        }
        if (stream.acceptWord('SET')) {
          stream.expectWord('DEFAULT');
          const literal = this.literal([stream.next()]);
          column.default = literal && literal.value !== null ? String(literal.value) : null;
        } else {
          stream.expectWord('DROP');
          stream.expectWord('DEFAULT');
          column.default = null;
        }
        return;
      }
      if (stream.acceptWord('DROP')) {
        if (stream.acceptWord('PRIMARY')) {
          stream.expectWord('KEY');
          definition.primaryKey = [];
          return;
        }
        if (stream.acceptWord('INDEX', 'KEY')) {
          this.dropKey(definition, stream.name());
          return;
        }
        stream.acceptWord('COLUMN');
        const name = stream.name();
        const index = definition.columns.findIndex(candidate => candidate.name.toLowerCase() === name.toLowerCase());
        if (index < 0) {
          throw new MysqlError(ER.KEY_DOES_NOT_EXIST, `Can't DROP '${name}'. Check that column/key exists`);
        }
        definition.columns.splice(index, 1);
        definition.primaryKey = definition.primaryKey.filter(column => column.toLowerCase() !== name.toLowerCase());
        for (const key of definition.keys) {
          key.columns = key.columns.filter(column => column.toLowerCase() !== name.toLowerCase());
        }
        definition.keys = definition.keys.filter(key => key.columns.length);
        return;
      }
      if (stream.acceptWord('RENAME')) {
        stream.acceptWord('TO', 'AS');
        definition.name = stream.name();
        return;
      }
      if (stream.isWord('TYPE', 'ENGINE', 'COMMENT', 'AUTO_INCREMENT', 'ORDER')) {
        stream.until([], [',']);
        return;
      }
      throw stream.error();
    }

    rebuild(entry, before, after, renamedFrom = {}) {
      const db = entry.db;
      // MyISAM never hands out a deleted id again, and ALTER TABLE keeps the
      // counter. SQLite's lives in sqlite_sequence and goes with the old table.
      const sequence = db.exec("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").length
        ? db.exec('SELECT seq FROM sqlite_sequence WHERE name = ?', [before.name]) : [];
      const counter = sequence.length ? sequence[0].values[0][0] : null;
      db.exec('SAVEPOINT phpwasm_alter');
      try {
        db.run(createTableSql(after, REBUILD));
        const copied = after.columns
          .map(column => ({ column, source: findColumn(before, renamedFrom[column.name] || column.name) }))
          .filter(pair => pair.source);
        if (copied.length) {
          db.run(`INSERT INTO ${quoteIdent(REBUILD)} (${copied.map(pair => quoteIdent(pair.column.name)).join(', ')})`
            + ` SELECT ${copied.map(pair => quoteIdent(pair.source.name)).join(', ')} FROM ${quoteIdent(before.name)}`);
        }
        db.run(`DROP TABLE ${quoteIdent(before.name)}`);
        db.run(`ALTER TABLE ${quoteIdent(REBUILD)} RENAME TO ${quoteIdent(after.name)}`);
        if (counter !== null && after.columns.some(column => usesRowid(after, column))) {
          db.run('UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?', [counter, after.name]);
        }
        for (const key of after.keys) {
          db.run(createIndexSql(after, key));
        }
        if (before.name !== after.name) {
          this.dropDefinition(entry, before.name);
        }
        this.saveDefinition(entry, after);
        db.exec('RELEASE phpwasm_alter');
      } catch (error) {
        db.exec('ROLLBACK TO phpwasm_alter');
        db.exec('RELEASE phpwasm_alter');
        entry.definitions.delete(before.name);
        entry.definitions.delete(after.name);
        throw error;
      }
    }

    // --- SHOW and friends ---------------------------------------------------

    show(link, stream) {
      stream.next();
      stream.acceptWord('FULL');
      if (stream.acceptWord('DATABASES')) {
        const like = this.likeFilter(stream);
        return this.textResult(['Database'], [...this.databases.keys()].sort().filter(like).map(name => [name]));
      }
      if (stream.acceptWord('TABLES')) {
        let entry = null;
        let name = link.database;
        if (stream.acceptWord('FROM', 'IN')) {
          name = stream.name();
          if (!this.databases.has(name)) {
            throw new MysqlError(ER.BAD_DB, `Unknown database '${name}'`);
          }
        }
        if (!name) {
          throw new MysqlError(ER.NO_DB, 'No Database Selected');
        }
        entry = this.databases.get(name);
        const pattern = stream.isWord('LIKE') ? stream.peek(1).value : null;
        const like = this.likeFilter(stream);
        const header = `Tables_in_${name}${pattern !== null ? ` (${pattern})` : ''}`;
        return this.textResult([header], this.tableNames(entry).filter(like).map(table => [table]));
      }
      if (stream.acceptWord('COLUMNS', 'FIELDS')) {
        stream.expectWord('FROM', 'IN');
        const table = stream.name();
        if (stream.acceptWord('FROM', 'IN')) {
          stream.name();
        }
        return this.showColumns(link, table, this.likeFilter(stream));
      }
      if (stream.acceptWord('INDEX', 'INDEXES', 'KEYS')) {
        stream.expectWord('FROM', 'IN');
        return this.showIndex(link, stream.name());
      }
      if (stream.acceptWord('TABLE')) {
        stream.expectWord('STATUS');
        if (stream.acceptWord('FROM', 'IN')) {
          stream.name();
        }
        return this.showTableStatus(link, this.likeFilter(stream));
      }
      if (stream.acceptWord('CREATE')) {
        stream.expectWord('TABLE');
        return this.showCreateTable(link, stream.name());
      }
      if (stream.acceptWord('VARIABLES')) {
        const like = this.likeFilter(stream);
        const variables = [['version', this.serverVersion], ['character_set', 'latin1'], ['sql_mode', '0']];
        return this.textResult(['Variable_name', 'Value'], variables.filter(([name]) => like(name)));
      }
      if (stream.acceptWord('STATUS')) {
        return this.textResult(['Variable_name', 'Value'], [['Uptime', '0'], ['Threads_connected', String(this.links.size)]]);
      }
      if (stream.acceptWord('PROCESSLIST')) {
        return this.textResult(['Id', 'User', 'Host', 'db', 'Command', 'Time', 'State', 'Info'],
          [...this.links].map(([id, other]) => [String(id), '', other.host, other.database, 'Sleep', '0', '', null]));
      }
      throw stream.error();
    }

    likeFilter(stream) {
      if (!stream.acceptWord('LIKE')) {
        return () => true;
      }
      const token = stream.next();
      if (!token || token.type !== 'string') {
        throw stream.error();
      }
      const regex = likePattern(token.value);
      return name => regex.test(name);
    }

    showColumns(link, table, like) {
      const definition = this.definition(this.database(link), table);
      const rows = definition.columns.filter(column => !like || like(column.name)).map(column => {
        const flags = fieldFlags(definition, column);
        const key = flags & FLAG.PRI_KEY ? 'PRI' : (flags & FLAG.UNIQUE_KEY ? 'UNI' : (flags & FLAG.MULTIPLE_KEY ? 'MUL' : ''));
        const defaultValue = column.default !== null ? column.default
          : (column.notNull && !column.autoIncrement && !TEXT_TYPES[column.base] ? implicitDefault(column) : null);
        return [column.name, columnTypeText(column), column.notNull ? '' : 'YES', key, defaultValue,
          column.autoIncrement ? 'auto_increment' : ''];
      });
      return this.textResult(['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'], rows, table);
    }

    showIndex(link, table) {
      const definition = this.definition(this.database(link), table);
      const rows = [];
      const add = (name, unique, columns) => columns.forEach((column, i) => rows.push(
        [table, unique ? '0' : '1', name, String(i + 1), column, 'A', null, null, null, '']));
      if (definition.primaryKey.length) {
        add('PRIMARY', true, definition.primaryKey);
      }
      for (const key of definition.keys) {
        add(key.name, key.unique, key.columns);
      }
      return this.textResult(['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name', 'Collation',
        'Cardinality', 'Sub_part', 'Packed', 'Comment'], rows, table);
    }

    showTableStatus(link, like) {
      const entry = this.database(link);
      const rows = this.tableNames(entry).filter(like).map(table => {
        const count = entry.db.exec(`SELECT count(*) FROM ${quoteIdent(table)}`)[0].values[0][0];
        const definition = this.definition(entry, table);
        const autoIncrement = definition.columns.find(column => column.autoIncrement);
        const next = autoIncrement
          ? String(entry.db.exec(`SELECT IFNULL(MAX(${quoteIdent(autoIncrement.name)}), 0) + 1 FROM ${quoteIdent(table)}`)[0].values[0][0])
          : null;
        return [table, 'MyISAM', 'Dynamic', String(count), '0', '0', '0', '0', '0', next, null, null, null, '', ''];
      });
      return this.textResult(['Name', 'Type', 'Row_format', 'Rows', 'Avg_row_length', 'Data_length',
        'Max_data_length', 'Index_length', 'Data_free', 'Auto_increment', 'Create_time', 'Update_time',
        'Check_time', 'Create_options', 'Comment'], rows);
    }

    showCreateTable(link, table) {
      const definition = this.definition(this.database(link), table);
      const lines = definition.columns.map(column => {
        let line = `  ${column.name} ${columnTypeText(column)}`;
        if (column.default !== null) {
          line += ` DEFAULT ${quoteString(column.default)}`;
        }
        line += column.notNull ? ' NOT NULL' : '';
        line += column.autoIncrement ? ' auto_increment' : '';
        return line;
      });
      if (definition.primaryKey.length) {
        lines.push(`  PRIMARY KEY (${definition.primaryKey.join(',')})`);
      }
      for (const key of definition.keys) {
        lines.push(`  ${key.unique ? 'UNIQUE ' : ''}KEY ${key.name} (${key.columns.join(',')})`);
      }
      return this.textResult(['Table', 'Create Table'], [[table, `CREATE TABLE ${table} (\n${lines.join(',\n')}\n) TYPE=MyISAM`]]);
    }

    maintenance(link, stream) {
      const entry = this.database(link);
      const operation = stream.next().value.toLowerCase();
      stream.expectWord('TABLE');
      const rows = [];
      do {
        const table = stream.name();
        this.definition(entry, table);
        rows.push([`${link.database}.${table}`, operation, 'status', 'OK']);
      } while (stream.acceptOp(','));
      return this.textResult(['Table', 'Op', 'Msg_type', 'Msg_text'], rows);
    }

    listFields(link, table, wild) {
      const entry = this.database(link);
      const definition = this.definition(entry, table);
      const like = wild ? likePattern(wild) : null;
      const fields = definition.columns.filter(column => !like || like.test(column.name)).map(column => ({
        ...columnField(definition, column),
        def: column.default !== null ? column.default : '',
      }));
      return this.result(fields, []);
    }

    sqliteError(error) {
      const message = String(error && error.message || error);
      let match = message.match(/no such table: (?:\w+\.)?(\S+)/);
      if (match) {
        return { errno: ER.NO_SUCH_TABLE, message: `Table '${match[1]}' doesn't exist` };
      }
      match = message.match(/no such column: (\S+)/);
      if (match) {
        return { errno: ER.BAD_FIELD, message: `Unknown column '${match[1]}' in 'field list'` };
      }
      if (/UNIQUE constraint failed/.test(message)) {
        return { errno: ER.DUP_ENTRY, message: `Duplicate entry for key 1 (${message})` };
      }
      match = message.match(/near "([^"]*)": syntax error/);
      if (match) {
        return { errno: ER.PARSE, message: `You have an error in your SQL syntax near '${match[1]}' at line 1` };
      }
      return { errno: ER.UNKNOWN, message: `Unknown error (SQLite: ${message})` };
    }
  }

  MysqlOnSqlite.tokenize = tokenize;
  MysqlOnSqlite.oldPassword = oldPassword;
  MysqlOnSqlite.FIELD_TYPE = FIELD_TYPE;
  MysqlOnSqlite.FLAG = FLAG;
  return MysqlOnSqlite;
});
