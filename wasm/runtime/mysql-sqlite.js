// A MySQL server for libmysql/libmysql.c, kept in SQLite (sql.js).
//
// It imitates one of two server versions, which each release file names:
//
//   3.23.49  the default, what TYPO3 3.3.0 and 3.8.1 talk to. It has no
//            character_set_* variables and no information_schema: both came
//            later, and each is refused with the error 3.23 sends. HEX() is
//            CONV(N,10,16), so it reads a string as a number. Every SET
//            statement is accepted and changes nothing.
//   5.5.62   what the 4.0.13 and 4.5.40 Docker stacks run. On top of 3.23's
//            statements, it answers:
//            the @@character_set_* and @@collation_* variables, the
//            connection's after SET NAMES or SET CHARACTER SET, and
//            @@sql_mode, also as @@SESSION.name, @@LOCAL.name and
//            @@GLOBAL.name;
//            information_schema.COLUMNS, built from each table's MySQL
//            definition; HEX() of a string's bytes, as since MySQL 4.0.1;
//            SHOW CHARACTER SET, and SHOW TABLE STATUS, SHOW KEYS and SHOW
//            CREATE TABLE with MySQL 5.5's columns, and with the ENGINE and
//            DEFAULT CHARSET each table was created with.
//            Everything else answers as it does for 3.23.
//
// A 5.5.62 server has a character set too, which the release file names
// beside the version, as the stack's --character-set-server does:
//
//   latin1   the default, what the 4.0.13 stack runs, collation
//            latin1_swedish_ci. Characters are bytes.
//   utf8     what the 4.5.40 stack runs, collation utf8_general_ci. Where
//            MySQL counts or compares characters, the shim reads the bytes
//            as UTF-8: varchar(n) and char(n) keep n characters,
//            CHAR_LENGTH() counts characters while LENGTH() counts bytes,
//            LOWER() and UPPER() change non-ASCII letters, and =, LIKE and
//            ORDER BY ignore case and accents, so "Gödöllő" equals "GODOLLO".
//            sql.js cannot add a collation to SQLite, so = and ORDER BY get
//            this through MYSQL_COLLATE_KEY(), which the translation adds:
//            = only between a column and a non-ASCII string, since SQLite
//            already compares ASCII without case. GROUP BY, DISTINCT and
//            other comparisons ignore the case of ASCII letters only.
//
// Neither converts: bytes go in and come out as the client sent them,
// whatever SET NAMES said, as when client and server agree on the charset.
//
// It answers what TYPO3 and its install tooling send, not every MySQL
// statement. SQL is tokenized with MySQL's rules (backslash escapes, both
// quote styles, backticks, "#" comments) and re-emitted for SQLite. Each
// table's MySQL definition is kept beside it, in __phpwasm_mysql_tables, so
// SHOW COLUMNS, field types and flags answer as MySQL would, and writes get
// MySQL's non-strict conversions: '' into an int column is 0, NULL into a NOT
// NULL column is its default, varchar(n) truncates, and 0 or NULL into an
// auto_increment column takes the next id.
//
// Strings are kept as bytes throughout: one JS char per byte, as PHP sends
// them. sql.js ends SQLite text at a NUL byte, in SQL, in bound values and in
// what it reads back, so a string with one, such as PHP's serialize() writes
// for a protected property, goes to SQLite as a BLOB of its bytes. It comes
// back byte for byte. LENGTH() counts its bytes, CHAR_LENGTH() its
// characters, LIKE matches it as any string, and = compares its bytes, with
// case. ORDER BY puts it after every string without a NUL byte.
//
// Every error it raises is one MySQL raises for the same statement, with
// MySQL's number. A statement it cannot translate fails in SQLite instead,
// as error 1105 with SQLite's message. The stack probes,
// probe/stack-<release>.cjs, record every statement answered with an error
// and fail on any. For TYPO3 3.3.0, 3.8.1 and 4.0.13 there are none, over
// what those probes reach: provisioning, the frontend, the backend login, record
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
  // Server error numbers and message formats as MySQL 3.23 sends them. 1193 is
  // in 3.23.49's list too (PHP 4.4.9's ext/mysql/libmysql/mysqld_error.h).
  const ER = {
    DB_CREATE_EXISTS: 1007, DB_DROP_EXISTS: 1008, ACCESS_DENIED: 1045,
    NO_DB: 1046, BAD_DB: 1049, TABLE_EXISTS: 1050, BAD_TABLE: 1051,
    BAD_FIELD: 1054, DUP_ENTRY: 1062, PARSE: 1064, EMPTY_QUERY: 1065,
    KEY_DOES_NOT_EXIST: 1091, UNKNOWN: 1105, NO_SUCH_TABLE: 1146,
    UNKNOWN_SYSTEM_VARIABLE: 1193, NOT_SUPPORTED: 1235,
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
    const text = String(value);
    if (text.includes('\0')) {
      let hex = '';
      for (let i = 0; i < text.length; i++) {
        hex += (text.charCodeAt(i) & 0xff).toString(16).padStart(2, '0');
      }
      return `X'${hex}'`;
    }
    return `'${text.replace(/'/g, "''")}'`;
  }

  // A value to bind or to return from a function: a string with a NUL byte as
  // a BLOB of its bytes, anything else as it is.
  function sqliteValue(value) {
    return typeof value === 'string' && value.includes('\0') ? bytesOfText(value) : value;
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
  // utf8_general_ci where SQLite has no collation for it

  const COLLATE_KEY = 'MYSQL_COLLATE_KEY';
  const ORDER_BY_END = ['LIMIT', 'PROCEDURE', 'INTO', 'FOR', 'LOCK', 'UNION'];
  const CONDITION_START = ['WHERE', 'HAVING', 'ON'];
  const CONDITION_END = ['SET', 'ORDER', 'GROUP', 'LIMIT', 'VALUES', 'SELECT', 'FROM', 'UNION'];
  const BEFORE_OPERAND = ['AND', 'OR', 'XOR', 'NOT', 'WHERE', 'HAVING', 'ON', 'WHEN', 'THEN', 'ELSE'];
  const AFTER_OPERAND = ['AND', 'OR', 'XOR', 'ORDER', 'GROUP', 'LIMIT', 'HAVING', 'THEN', 'ELSE', 'END', 'WHEN', 'UNION'];
  const COMPARISONS = ['=', '<>', '!=', '<=>'];

  // MYSQL_COLLATE_KEY( tokens ), spanning the tokens' own text, so a result
  // column keeps the name MySQL gives it.
  function wrapInCollateKey(tokens) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    return [
      { type: 'word', value: COLLATE_KEY, upper: COLLATE_KEY, start: first.start, end: first.start },
      { type: 'op', value: '(', start: first.start, end: first.start },
      ...tokens,
      { type: 'op', value: ')', start: last.end, end: last.end },
    ];
  }

  // Each ORDER BY term, but a column number, sorts by its key.
  function collateOrderBy(tokens) {
    const out = [];
    const flush = term => {
      let end = term.length;
      if (end && term[end - 1].type === 'word' && (term[end - 1].upper === 'ASC' || term[end - 1].upper === 'DESC')) {
        end--;
      }
      const expression = term.slice(0, end);
      if (!expression.length || (expression.length === 1 && expression[0].type === 'number')) {
        out.push(...term);
      } else {
        out.push(...wrapInCollateKey(expression), ...term.slice(end));
      }
    };
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i++];
      out.push(token);
      if (!(token.type === 'word' && token.upper === 'ORDER' && tokens[i] && tokens[i].upper === 'BY')) {
        continue;
      }
      out.push(tokens[i++]);
      let depth = 0;
      let term = [];
      while (i < tokens.length) {
        const next = tokens[i];
        if (next.type === 'op' && next.value === ')' && depth === 0) {
          break;
        }
        if (depth === 0 && next.type === 'word' && ORDER_BY_END.includes(next.upper)) {
          break;
        }
        if (next.type === 'op' && next.value === '(') {
          depth++;
        } else if (next.type === 'op' && next.value === ')') {
          depth--;
        }
        i++;
        if (depth === 0 && next.type === 'op' && next.value === ',') {
          flush(term);
          out.push(next);
          term = [];
        } else {
          term.push(next);
        }
      }
      flush(term);
    }
    return out;
  }

  // A column compared with a string that is not ASCII: both sides by key,
  // in WHERE, HAVING and ON. ASCII needs nothing, as SQLite's NOCASE
  // already ignores its case.
  function collateComparisons(tokens) {
    const isWord = (token, words) => token && token.type === 'word' && words.includes(token.upper);
    const isOp = (token, ops) => token && token.type === 'op' && ops.includes(token.value);
    const startsOperand = i => i < 0 || isOp(tokens[i], ['(', ',']) || isWord(tokens[i], BEFORE_OPERAND);
    const endsOperand = i => i >= tokens.length || isOp(tokens[i], [')', ',']) || isWord(tokens[i], AFTER_OPERAND);
    const nonAscii = token => token && token.type === 'string' && /[\u0080-\u00ff]/.test(token.value);
    // [first, last] of the column reference ending at i, or null.
    const referenceEndingAt = i => {
      if (!isNameToken(tokens[i])) {
        return null;
      }
      let first = i;
      while (isOp(tokens[first - 1], ['.']) && isNameToken(tokens[first - 2])) {
        first -= 2;
      }
      return startsOperand(first - 1) ? [first, i] : null;
    };
    const referenceStartingAt = i => {
      if (!isNameToken(tokens[i]) || isOp(tokens[i + 1], ['('])) {
        return null;
      }
      let last = i;
      while (isOp(tokens[last + 1], ['.']) && isNameToken(tokens[last + 2])) {
        last += 2;
      }
      return endsOperand(last + 1) ? [i, last] : null;
    };

    const ranges = [];
    const conditions = [];
    let inCondition = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (isOp(token, ['('])) {
        conditions.push(inCondition);
      } else if (isOp(token, [')'])) {
        inCondition = conditions.length ? conditions.pop() : false;
      } else if (isWord(token, CONDITION_START)) {
        inCondition = !(token.upper === 'ON' && isWord(tokens[i + 1], ['DUPLICATE']));
      } else if (isWord(token, CONDITION_END)) {
        inCondition = false;
      } else if (inCondition && isOp(token, COMPARISONS)) {
        let reference = null;
        if (nonAscii(tokens[i + 1]) && endsOperand(i + 2)) {
          reference = referenceEndingAt(i - 1);
          if (reference) {
            ranges.push(reference, [i + 1, i + 1]);
          }
        } else if (nonAscii(tokens[i - 1]) && startsOperand(i - 2)) {
          reference = referenceStartingAt(i + 1);
          if (reference) {
            ranges.push([i - 1, i - 1], reference);
          }
        }
      }
    }
    if (!ranges.length) {
      return tokens;
    }
    const out = [];
    let at = 0;
    for (const [first, last] of ranges.sort((a, b) => a[0] - b[0])) {
      out.push(...tokens.slice(at, first), ...wrapInCollateKey(tokens.slice(first, last + 1)));
      at = last + 1;
    }
    out.push(...tokens.slice(at));
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
    // A utf8 char(n) or varchar(n) holds n characters; text and blob limits
    // are bytes in every charset.
    if (column.charset === 'utf8' && (column.base === 'CHAR' || column.base === 'VARCHAR')) {
      return utf8Length(text) > limit ? utf8Prefix(text, limit) : text;
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
  // What depends on the server version

  function majorVersion(serverVersion) {
    return Number(String(serverVersion).split('.')[0]);
  }

  // [name, value] as SHOW VARIABLES lists them and SELECT @@name reads them,
  // for a link, whose SET NAMES changes the client's three. Only the
  // variables something here reads: SHOW VARIABLES is not a full list for
  // either version.
  function serverVariables(serverVersion, charset = 'latin1', link = null) {
    if (majorVersion(serverVersion) < 5) {
      return [['version', serverVersion], ['character_set', 'latin1'], ['sql_mode', '0']];
    }
    // Each stack's server runs with --character-set-server and an empty
    // sql_mode, mysql:5.5's own default. A connection starts in the server's
    // charset. The database's is the server's: CREATE DATABASE here takes
    // no charset of its own.
    const connection = (link && link.characterSets) || { client: charset, connection: charset, results: charset };
    return [
      ['character_set_client', connection.client],
      ['character_set_connection', connection.connection],
      ['character_set_database', charset],
      ['character_set_results', connection.results],
      ['character_set_server', charset],
      ['character_set_system', 'utf8'],
      ['collation_connection', collationOf(connection.connection, false)],
      ['collation_database', collationOf(charset, false)],
      ['collation_server', collationOf(charset, false)],
      ['sql_mode', ''],
      ['version', serverVersion],
    ];
  }

  const SERVER_VERSIONS = ['3.23.49', '5.5.62'];

  // Character set variables came with MySQL 4.1. 3.23 refuses them by name.
  const CHARACTER_SET_VARIABLES = /^character_set_/i;

  const UINT64 = 2n ** 64n;

  function hexOfInteger(value) {
    return BigInt.asUintN(64, value).toString(16).toUpperCase();
  }

  // MySQL 3.23's HEX(N) is CONV(N,10,16): the argument's text through
  // strtoull(), which skips leading space, stops at the first non-digit,
  // negates a leading minus modulo 2^64 and saturates on overflow.
  function hexAsMysql323(text) {
    const match = /^\s*([+-]?)(\d*)/.exec(text);
    let number = match[2] ? BigInt(match[2]) : 0n;
    if (number >= UINT64) {
      return 'FFFFFFFFFFFFFFFF';
    }
    if (match[1] === '-') {
      number = -number;
    }
    return hexOfInteger(number);
  }

  // From MySQL 4.0.1: a string's bytes, two digits each; a number as an
  // integer, a fraction rounded half away from zero.
  function hexAsMysql5(value, text) {
    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return hexOfInteger(BigInt(value));
      }
      const rounded = value < 0 ? Math.ceil(value - 0.5) : Math.floor(value + 0.5);
      return Number.isFinite(rounded) && Math.abs(rounded) < 2 ** 63 ? hexOfInteger(BigInt(rounded)) : 'FFFFFFFFFFFFFFFF';
    }
    let hex = '';
    for (let i = 0; i < text.length; i++) {
      hex += text.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0');
    }
    return hex;
  }

  // ---------------------------------------------------------------------
  // Character sets

  // The character sets a 5.5.62 server can be given, as SHOW CHARACTER SET
  // lists them.
  const CHARSETS = {
    latin1: { description: 'cp1252 West European', collation: 'latin1_swedish_ci', maxlen: 1 },
    utf8: { description: 'UTF-8 Unicode', collation: 'utf8_general_ci', maxlen: 3 },
  };
  const ER_UNKNOWN_CHARACTER_SET = 1115;

  function collationOf(charset, binary) {
    return binary ? `${charset}_bin` : CHARSETS[charset].collation;
  }

  function knownCharset(name) {
    const charset = String(name).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(CHARSETS, charset)) {
      throw new MysqlError(ER_UNKNOWN_CHARACTER_SET, `Unknown character set: '${name}'`);
    }
    return charset;
  }

  function bytesOfText(text) {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      bytes[i] = text.charCodeAt(i) & 0xff;
    }
    return bytes;
  }

  const utf8Decoder = new TextDecoder('utf-8');
  const utf8Encoder = new TextEncoder();

  function decodeUtf8(text) {
    return utf8Decoder.decode(bytesOfText(text));
  }

  function encodeUtf8(text) {
    return latin1FromBytes(utf8Encoder.encode(text));
  }

  // A UTF-8 byte that does not continue a sequence starts a character.
  function startsCharacter(code) {
    return (code & 0xc0) !== 0x80;
  }

  function utf8Length(text) {
    let count = 0;
    for (let i = 0; i < text.length; i++) {
      if (startsCharacter(text.charCodeAt(i))) {
        count++;
      }
    }
    return count;
  }

  // The first count characters, cut before a character's first byte.
  function utf8Prefix(text, count) {
    let seen = 0;
    for (let i = 0; i < text.length; i++) {
      if (startsCharacter(text.charCodeAt(i))) {
        if (seen === count) {
          return text.slice(0, i);
        }
        seen++;
      }
    }
    return text;
  }

  // utf8_general_ci compares one weight per character: the upper case of its
  // base letter, so "ö", "Ö", "ő" and "o" weigh the same, and "ß" weighs "S".
  function generalCiWeight(char) {
    if (char === '\u00df') {
      return 'S';
    }
    const base = char.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const upper = (base.length === 1 ? base : char).toUpperCase();
    return upper.length === 1 ? upper : char;
  }

  // A string's utf8_general_ci weights, as UTF-8 bytes: SQLite compares
  // them in code point order, which is the order MySQL sorts weights in.
  function utf8GeneralCiKey(text) {
    let key = '';
    for (const char of decodeUtf8(text)) {
      key += generalCiWeight(char);
    }
    return encodeUtf8(key);
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // MySQL's LIKE under utf8_general_ci: % and _ match characters, and
  // letters match by weight.
  function utf8Like(pattern, subject, escape) {
    const escapeChar = escape === undefined ? null : decodeUtf8(escape);
    const chars = Array.from(decodeUtf8(pattern));
    let regex = '';
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char === escapeChar && i + 1 < chars.length) {
        regex += escapeRegExp(generalCiWeight(chars[++i]));
      } else if (char === '%') {
        regex += '[\\s\\S]*';
      } else if (char === '_') {
        regex += '[\\s\\S]';
      } else {
        regex += escapeRegExp(generalCiWeight(char));
      }
    }
    const weights = Array.from(decodeUtf8(subject), generalCiWeight).join('');
    return new RegExp(`^${regex}$`, 'u').test(weights);
  }

  // SQLite's own LIKE, as latin1 servers have it, over every byte: % and _
  // match characters, and ASCII letters match without case.
  function foldAscii(text) {
    return text.replace(/[A-Z]/g, letter => letter.toLowerCase());
  }

  function asciiCiLikeRegExp(pattern, escape) {
    const chars = foldAscii(pattern);
    const escapeChar = escape === undefined ? null : foldAscii(escape);
    let regex = '';
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char === escapeChar && i + 1 < chars.length) {
        regex += escapeRegExp(chars[++i]);
      } else if (char === '%') {
        regex += '[\\s\\S]*';
      } else if (char === '_') {
        regex += '[\\s\\S]';
      } else {
        regex += escapeRegExp(char);
      }
    }
    return new RegExp(`^${regex}$`);
  }

  // SQLite calls LIKE once per row with the same pattern, so the last
  // pattern's expression is kept.
  let lastAsciiCiLike = { pattern: null, escape: null, regex: null };
  function asciiCiLike(pattern, subject, escape) {
    if (lastAsciiCiLike.pattern !== pattern || lastAsciiCiLike.escape !== escape) {
      lastAsciiCiLike = { pattern, escape, regex: asciiCiLikeRegExp(pattern, escape) };
    }
    return lastAsciiCiLike.regex.test(foldAscii(subject));
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

  function registerFunctions(db, now, serverVersion, charset = 'latin1') {
    const anyNull = args => args.some(arg => arg === null);
    const text = value => (value instanceof Uint8Array ? latin1FromBytes(value) : String(value));
    const comparable = value => (value instanceof Uint8Array ? latin1FromBytes(value) : value);
    const utf8 = charset === 'utf8';
    const lower = utf8 ? value => encodeUtf8(decodeUtf8(text(value)).toLowerCase()) : value => text(value).toLowerCase();
    const upper = utf8 ? value => encodeUtf8(decodeUtf8(text(value)).toUpperCase()) : value => text(value).toUpperCase();
    const charLength = utf8 ? value => utf8Length(text(value)) : value => text(value).length;
    const hex = majorVersion(serverVersion) < 5 ? (value => hexAsMysql323(text(value))) : (value => hexAsMysql5(value, text(value)));
    db.create_function('HEX', value => (value === null ? null : hex(value)));
    db.create_function('MYSQL_CONCAT', variadic(function () {
      const args = Array.from(arguments);
      return anyNull(args) ? null : sqliteValue(args.map(text).join(''));
    }));
    db.create_function('MYSQL_CONCAT_WS', variadic(function () {
      const [separator, ...args] = Array.from(arguments);
      return separator === null ? null : sqliteValue(args.filter(arg => arg !== null).map(text).join(text(separator)));
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
    db.create_function('LCASE', value => (value === null ? null : sqliteValue(lower(value))));
    db.create_function('UCASE', value => (value === null ? null : sqliteValue(upper(value))));
    db.create_function('LEFT', (value, length) => (value === null || length === null ? null
      : sqliteValue(text(value).slice(0, Math.max(0, length)))));
    db.create_function('RIGHT', (value, length) => (value === null || length === null ? null
      : sqliteValue(length > 0 ? text(value).slice(-length) : '')));
    db.create_function('MID', (value, position, length) => (value === null ? null
      : sqliteValue(text(value).substr(position - 1, length))));
    db.create_function('CHAR_LENGTH', value => (value === null ? null : charLength(value)));
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
      return anyNull(args) ? null : sqliteValue(args.map(comparable).reduce((a, b) => (b > a ? b : a)));
    }));
    db.create_function('LEAST', variadic(function () {
      const args = Array.from(arguments);
      return anyNull(args) ? null : sqliteValue(args.map(comparable).reduce((a, b) => (b < a ? b : a)));
    }));
    db.create_function('PASSWORD', value => (value === null ? null : oldPassword(text(value))));
    // SQLite calls regexp(pattern, subject) for "subject REGEXP pattern".
    db.create_function('REGEXP', (pattern, subject) => (pattern === null || subject === null ? null
      : (new RegExp(text(pattern), 'i').test(text(subject)) ? 1 : 0)));
    // SQLite's own LIKE stops at a NUL byte, and under utf8 knows ASCII only.
    // sql.js keeps one function per name, so LIKE's two forms go by two
    // spellings.
    const like = utf8 ? utf8Like : asciiCiLike;
    db.create_function('like', (pattern, subject) => (pattern === null || subject === null ? null
      : (like(text(pattern), text(subject)) ? 1 : 0)));
    db.create_function('LIKE', (pattern, subject, escape) => (pattern === null || subject === null ? null
      : (like(text(pattern), text(subject), escape === null ? undefined : text(escape)) ? 1 : 0)));
    if (!utf8) {
      return;
    }
    // SQLite's own LOWER() and UPPER() know ASCII only.
    db.create_function('CHARACTER_LENGTH', value => (value === null ? null : charLength(value)));
    db.create_function('LOWER', value => (value === null ? null : sqliteValue(lower(value))));
    db.create_function('UPPER', value => (value === null ? null : sqliteValue(upper(value))));
    db.create_function(COLLATE_KEY, value => (typeof value === 'string' || value instanceof Uint8Array
      ? sqliteValue(utf8GeneralCiKey(text(value))) : value));
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
    //   serverVersion: '3.23.49' or '5.5.62', see the top of this file
    //   charset: 'latin1' or 'utf8', 5.5.62's --character-set-server
    constructor(SQL, { serverVersion = '3.23.49', charset = 'latin1', users = null, now = () => Date.now() } = {}) {
      if (!SERVER_VERSIONS.includes(serverVersion)) {
        throw new Error(`MySQL ${serverVersion} is not imitated, only ${SERVER_VERSIONS.join(' and ')}`);
      }
      if (!Object.prototype.hasOwnProperty.call(CHARSETS, charset)) {
        throw new Error(`The character set ${charset} is not imitated, only ${Object.keys(CHARSETS).join(' and ')}`);
      }
      if (charset !== 'latin1' && majorVersion(serverVersion) < 5) {
        throw new Error(`MySQL ${serverVersion} has one character set, latin1`);
      }
      this.SQL = SQL;
      this.serverVersion = serverVersion;
      this.charset = charset;
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
      registerFunctions(db, this.now, this.serverVersion, this.charset);
      this.databases.set(name, { db, definitions: new Map() });
    }

    exportDatabase(name) {
      const entry = this.databases.get(name);
      if (!entry) {
        throw new Error(`No database ${name}`);
      }
      // sql.js closes and reopens the database to export it, which drops the
      // functions registered on it. The site exports after every write.
      const bytes = entry.db.export();
      registerFunctions(entry.db, this.now, this.serverVersion, this.charset);
      return bytes;
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
      const collated = this.charset === 'utf8' && tokens[0].type === 'word'
        && ['SELECT', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE'].includes(tokens[0].upper)
        ? collateComparisons(collateOrderBy(tokens)) : tokens;
      const stream = new TokenStream(collated, sql);
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
          return this.set(link, stream);
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

    // SET NAMES and SET CHARACTER SET change what the link's @@character_set_*
    // variables read, as in MySQL 5.5. Any other SET changes nothing.
    set(link, stream) {
      if (majorVersion(this.serverVersion) < 5) {
        return this.ok();
      }
      stream.next();
      const charsetName = () => {
        if (stream.acceptWord('DEFAULT')) {
          return this.charset;
        }
        const token = stream.next();
        if (!token || !(isNameToken(token) || token.type === 'string')) {
          throw stream.error();
        }
        return knownCharset(token.value);
      };
      if (stream.acceptWord('NAMES')) {
        const charset = charsetName();
        link.characterSets = { client: charset, connection: charset, results: charset };
      } else if (stream.acceptWord('CHARSET')
          || (stream.isWord('CHARACTER') && stream.peek(1) && stream.peek(1).upper === 'SET' && stream.next() && stream.next())) {
        const charset = charsetName();
        link.characterSets = { client: charset, connection: this.charset, results: charset };
      }
      return this.ok();
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
      this.resolveSystemVariables(stream.tokens, link);
      const informationSchemaWith = this.resolveInformationSchema(stream.tokens);
      const entry = link.database && !informationSchemaWith ? this.databases.get(link.database) : null;
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
      } else if (!entry && !informationSchemaWith && rest.length && rest[0].upper === 'FROM') {
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
      const sqliteSql = `${informationSchemaWith || ''}SELECT ${distinct ? 'DISTINCT ' : ''}${emittedItems.join(', ')} ${emit(rest)}`.trim();
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

    // Replaces each @@name in a SELECT with the variable's value, as a string
    // token spanning the original text, so the column is still named
    // "@@name". On 5.5, @@SESSION.name and @@LOCAL.name are the connection's
    // value, and @@GLOBAL.name the server's. A name neither refused nor known
    // here is left to SQLite.
    resolveSystemVariables(tokens, link) {
      const known = scope => new Map(serverVariables(this.serverVersion, this.charset, scope === 'GLOBAL' ? null : link)
        .map(([name, value]) => [name.toLowerCase(), value]));
      const mysql5 = majorVersion(this.serverVersion) >= 5;
      for (let i = 0; i + 2 < tokens.length; i++) {
        const [at, at2, first] = [tokens[i], tokens[i + 1], tokens[i + 2]];
        if (!(at.type === 'op' && at.value === '@' && at2.type === 'op' && at2.value === '@'
            && at.end === at2.start && at2.end === first.start && isNameToken(first))) {
          continue;
        }
        let scope = 'SESSION';
        let name = first;
        let count = 3;
        const [dot, scoped] = [tokens[i + 3], tokens[i + 4]];
        if (mysql5 && first.type === 'word' && ['SESSION', 'LOCAL', 'GLOBAL'].includes(first.upper)
            && dot && dot.type === 'op' && dot.value === '.' && scoped && isNameToken(scoped)) {
          scope = first.upper;
          name = scoped;
          count = 5;
        }
        if (!mysql5 && CHARACTER_SET_VARIABLES.test(name.value)) {
          throw new MysqlError(ER.UNKNOWN_SYSTEM_VARIABLE, `Unknown system variable '${name.value}'`);
        }
        const values = known(scope);
        if (mysql5 && values.has(name.value.toLowerCase())) {
          tokens.splice(i, count, { type: 'string', value: values.get(name.value.toLowerCase()), start: at.start, end: name.end });
        }
      }
    }

    // Replaces information_schema.COLUMNS in a SELECT with a table of the same
    // name, built in a WITH clause, which it returns. The statement then runs
    // in the scratch database, as information_schema's tables belong to no
    // database. Returns null for a SELECT that does not read
    // information_schema.
    resolveInformationSchema(tokens) {
      let withClause = null;
      for (let i = 0; i + 2 < tokens.length; i++) {
        const [schema, dot, table] = [tokens[i], tokens[i + 1], tokens[i + 2]];
        if (!(isNameToken(schema) && schema.value.toLowerCase() === 'information_schema'
            && dot.type === 'op' && dot.value === '.' && isNameToken(table))) {
          continue;
        }
        if (majorVersion(this.serverVersion) < 5) {
          throw new MysqlError(ER.NO_SUCH_TABLE, `Table '${schema.value}.${table.value}' doesn't exist`);
        }
        if (table.value.toUpperCase() !== 'COLUMNS') {
          throw new MysqlError(ER.UNKNOWN, `information_schema.${table.value} is not imitated, only COLUMNS`);
        }
        withClause = this.informationSchemaColumns(table.value);
        tokens.splice(i, 3, { type: 'ident', value: table.value, start: schema.start, end: table.end });
      }
      return withClause;
    }

    // information_schema.COLUMNS, with the columns that MySQL 5.5 fills in
    // from a table definition alone. Not DATA_TYPE: the shim keeps a type as
    // written, so INTEGER would read "integer", where MySQL says "int". Text
    // columns have the charset their table was created with, the server's
    // unless it said otherwise; numbers, dates and blobs have none, as in
    // MySQL.
    informationSchemaColumns(name) {
      const columns = ['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION',
        'COLUMN_DEFAULT', 'IS_NULLABLE', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'COLUMN_TYPE'];
      const rows = [];
      for (const [schema, entry] of [...this.databases].sort(([a], [b]) => (a < b ? -1 : 1))) {
        for (const table of this.tableNames(entry)) {
          this.definition(entry, table).columns.forEach((column, i) => {
            const text = typeKind(column.base) === 'text';
            const charset = column.charset || this.charset;
            rows.push([
              quoteString('def'), quoteString(schema), quoteString(table), quoteString(column.name), String(i + 1),
              column.default === null ? 'NULL' : quoteString(column.default),
              quoteString(column.notNull ? 'NO' : 'YES'),
              text ? quoteString(charset) : 'NULL',
              text ? quoteString(column.collation || collationOf(charset, column.binary)) : 'NULL',
              quoteString(columnTypeText(column)),
            ]);
          });
        }
      }
      const body = rows.length
        ? `VALUES ${rows.map(row => `(${row.join(', ')})`).join(', ')}`
        : `SELECT ${columns.map(() => 'NULL').join(', ')} WHERE 0`;
      return `WITH ${quoteIdent(name)}(${columns.map(quoteIdent).join(', ')}) AS (${body}) `;
    }

    scratchDatabase() {
      if (!this.scratch) {
        this.scratch = new this.SQL.Database();
        registerFunctions(this.scratch, this.now, this.serverVersion, this.charset);
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
      params.push(sqliteValue(coerceLiteral(column, literal.value)));
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
      if (majorVersion(this.serverVersion) >= 5) {
        this.tableOptions(new TokenStream(options, stream.sql), definition);
        definition.engine = definition.engine || 'InnoDB';
        definition.charset = definition.charset || this.charset;
        this.columnCharsets(definition);
      }
      this.createTable(entry, definition);
      return this.ok();
    }

    // ENGINE (or TYPE), [DEFAULT] CHARSET or CHARACTER SET, and [DEFAULT]
    // COLLATE, each with or without "=". Other options are skipped.
    tableOptions(stream, definition) {
      const value = () => {
        stream.acceptOp('=');
        const token = stream.next();
        if (!token) {
          throw stream.error();
        }
        return token.value;
      };
      while (!stream.atEnd()) {
        stream.acceptWord('DEFAULT');
        if (stream.acceptWord('ENGINE', 'TYPE')) {
          definition.engine = value();
        } else if (stream.acceptWord('CHARSET')
            || (stream.isWord('CHARACTER') && stream.peek(1) && stream.peek(1).upper === 'SET' && stream.next() && stream.next())) {
          definition.charset = knownCharset(value());
        } else if (stream.acceptWord('COLLATE')) {
          definition.collation = value().toLowerCase();
        } else {
          stream.next();
        }
      }
    }

    // Each text column without a charset of its own takes the table's.
    columnCharsets(definition) {
      for (const column of definition.columns) {
        if (typeKind(column.base) === 'text' && !column.charset) {
          column.charset = definition.charset || this.charset;
        }
      }
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
        } else if (majorVersion(this.serverVersion) >= 5 && (stream.acceptWord('CHARSET')
            || (stream.isWord('CHARACTER') && stream.peek(1) && stream.peek(1).upper === 'SET' && stream.next() && stream.next()))) {
          column.charset = knownCharset(stream.next().value);
        } else if (majorVersion(this.serverVersion) >= 5 && stream.acceptWord('COLLATE')) {
          column.collation = stream.next().value.toLowerCase();
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
      if (majorVersion(this.serverVersion) >= 5) {
        this.columnCharsets(after);
      }
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
      if (majorVersion(this.serverVersion) >= 5 && stream.isWord('TYPE', 'ENGINE')) {
        stream.next();
        stream.acceptOp('=');
        definition.engine = stream.next().value;
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
        let database = null;
        if (stream.acceptWord('FROM', 'IN')) {
          database = stream.name();
          if (!this.databases.has(database)) {
            throw new MysqlError(ER.BAD_DB, `Unknown database '${database}'`);
          }
        }
        return this.showTableStatus(link, this.likeFilter(stream), database);
      }
      if (majorVersion(this.serverVersion) >= 5 && (stream.acceptWord('CHARSET')
          || (stream.isWord('CHARACTER') && stream.peek(1) && stream.peek(1).upper === 'SET' && stream.next() && stream.next()))) {
        const like = this.likeFilter(stream);
        return this.textResult(['Charset', 'Description', 'Default collation', 'Maxlen'],
          Object.entries(CHARSETS).filter(([name]) => like(name))
            .map(([name, about]) => [name, about.description, about.collation, String(about.maxlen)]));
      }
      if (stream.acceptWord('CREATE')) {
        stream.expectWord('TABLE');
        return this.showCreateTable(link, stream.name());
      }
      if (stream.acceptWord('VARIABLES')) {
        const like = this.likeFilter(stream);
        return this.textResult(['Variable_name', 'Value'],
          serverVariables(this.serverVersion, this.charset, link).filter(([name]) => like(name)));
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
      const mysql5 = majorVersion(this.serverVersion) >= 5;
      const rows = [];
      // MySQL 5.5 adds Null, Index_type and Index_comment.
      const add = (name, unique, columns) => columns.forEach((column, i) => {
        const row = [table, unique ? '0' : '1', name, String(i + 1), column, 'A', null, null, null];
        if (mysql5) {
          const found = findColumn(definition, column);
          row.push(found && !found.notNull ? 'YES' : '', 'BTREE', '', '');
        } else {
          row.push('');
        }
        rows.push(row);
      });
      if (definition.primaryKey.length) {
        add('PRIMARY', true, definition.primaryKey);
      }
      for (const key of definition.keys) {
        add(key.name, key.unique, key.columns);
      }
      return this.textResult(['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name', 'Collation',
        'Cardinality', 'Sub_part', 'Packed', ...(mysql5 ? ['Null', 'Index_type', 'Comment', 'Index_comment'] : ['Comment'])],
      rows, table);
    }

    showTableStatus(link, like, database = null) {
      const entry = database ? this.databases.get(database) : this.database(link);
      const mysql5 = majorVersion(this.serverVersion) >= 5;
      const rows = this.tableNames(entry).filter(like).map(table => {
        const count = entry.db.exec(`SELECT count(*) FROM ${quoteIdent(table)}`)[0].values[0][0];
        const definition = this.definition(entry, table);
        const autoIncrement = definition.columns.find(column => column.autoIncrement);
        const next = autoIncrement
          ? String(entry.db.exec(`SELECT IFNULL(MAX(${quoteIdent(autoIncrement.name)}), 0) + 1 FROM ${quoteIdent(table)}`)[0].values[0][0])
          : null;
        if (!mysql5) {
          return [table, 'MyISAM', 'Dynamic', String(count), '0', '0', '0', '0', '0', next, null, null, null, '', ''];
        }
        const engine = definition.engine || 'InnoDB';
        const charset = definition.charset || this.charset;
        return [table, engine, '10', engine.toLowerCase() === 'innodb' ? 'Compact' : 'Dynamic', String(count),
          '0', '0', '0', '0', '0', next, null, null, null,
          definition.collation || collationOf(charset, false), null, '', ''];
      });
      if (!mysql5) {
        return this.textResult(['Name', 'Type', 'Row_format', 'Rows', 'Avg_row_length', 'Data_length',
          'Max_data_length', 'Index_length', 'Data_free', 'Auto_increment', 'Create_time', 'Update_time',
          'Check_time', 'Create_options', 'Comment'], rows);
      }
      return this.textResult(['Name', 'Engine', 'Version', 'Row_format', 'Rows', 'Avg_row_length', 'Data_length',
        'Max_data_length', 'Index_length', 'Data_free', 'Auto_increment', 'Create_time', 'Update_time',
        'Check_time', 'Collation', 'Checksum', 'Create_options', 'Comment'], rows);
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
      const options = majorVersion(this.serverVersion) >= 5
        ? `ENGINE=${definition.engine || 'InnoDB'} DEFAULT CHARSET=${definition.charset || this.charset}`
        : 'TYPE=MyISAM';
      return this.textResult(['Table', 'Create Table'], [[table, `CREATE TABLE ${table} (\n${lines.join(',\n')}\n) ${options}`]]);
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
