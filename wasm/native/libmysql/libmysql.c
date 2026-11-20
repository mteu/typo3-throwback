/*
 * A MySQL client library whose "server" is JS: every call that would go over
 * the wire goes to Module.phpMysqlCall (runtime/php-runtime.js), which hands
 * it to runtime/mysql-sqlite.js. mysql.h says which client API it is built
 * as: 3.23.49 for PHP 4, or 5.5.62 with prepared statements for PHP 5.
 *
 * The answer comes back as one malloc'd buffer:
 *
 *   u32 kind: 0 error, 1 ok, 2 result set, 3 link
 *   error:  u32 errno, str message
 *   ok:     u32 affected (low, high), u32 insert id (low, high), str info
 *   link:   u32 link id, str server version, str host info, str charset
 *   result: u32 field count, u32 row count,
 *           per field: str name, str table, str def,
 *                      u32 type, length, max_length, flags, decimals,
 *           per row, per field: u32 length (0xFFFFFFFF for NULL), bytes, NUL
 *   str:    u32 length, bytes, NUL
 *
 * Integers are little-endian, as in wasm memory. Strings are NUL-terminated
 * in place, so MYSQL_ROW cells and field names point into the buffer, which a
 * result set owns until mysql_free_result().
 *
 * Prepared statements are the client's alone: the server here speaks only
 * text SQL. mysql_stmt_prepare() finds the placeholders, and for a SELECT
 * learns its columns as a server would, by running it with NULL for each.
 * mysql_stmt_execute() puts the bound values in as literals, escaped as
 * mysql_real_escape_string() escapes them, and runs the result as one query.
 * mysql_stmt_fetch() converts each column into the type its buffer was
 * bound as.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <emscripten.h>

#include "mysql.h"

#define OP_CONNECT 1
#define OP_CLOSE 2
#define OP_SELECT_DB 3
#define OP_QUERY 4
#define OP_LIST_FIELDS 5
#define OP_PING 6

#define KIND_ERROR 0
#define KIND_OK 1
#define KIND_RESULT 2
#define KIND_LINK 3

#define NULL_LENGTH 0xFFFFFFFFu

/* Client error codes and texts as in the real client's errmsg.c. */
#define CR_UNKNOWN_ERROR 2000
#define CR_CONN_HOST_ERROR 2003
#define CR_OUT_OF_MEMORY 2008
#define CR_SERVER_LOST 2013
#define CR_COMMANDS_OUT_OF_SYNC 2014
#define CR_CANT_READ_CHARSET 2019
#define CR_NO_PREPARE_STMT 2030
#define CR_PARAMS_NOT_BOUND 2031
#define CR_INVALID_PARAMETER_NO 2034
#define CR_UNSUPPORTED_PARAM_TYPE 2036
#define CR_NO_STMT_METADATA 2052
#define CR_NOT_IMPLEMENTED 2054

#define ER_PARSE_ERROR 1064

/* What every error without a more specific SQLSTATE says, as in the real
   client and server. */
#define UNKNOWN_SQLSTATE "HY000"

#ifdef WASM_LIBMYSQL_API_55
struct known_charset {
    CHARSET_INFO info;
    const char *comment;
    unsigned int mbmaxlen;
};

/* The two charsets mysql-sqlite.js imitates, numbered as MySQL 5.5 numbers
   their default collations. */
static struct known_charset known_charsets[] = {
    { { 8, "latin1", "latin1_swedish_ci" }, "cp1252 West European", 1 },
    { { 33, "utf8", "utf8_general_ci" }, "UTF-8 Unicode", 3 }
};

#define BINARY_CHARSET_NUMBER 63
#endif

EM_JS(char *, php_mysql_server_call, (int op, unsigned int link,
    const char *a, unsigned int a_length, const char *b, unsigned int b_length,
    const char *c, unsigned int c_length), {
    if (!Module.phpMysqlCall) {
        return 0;
    }
    var bytes = function (pointer, length) {
        return pointer ? HEAPU8.slice(pointer, pointer + length) : null;
    };
    return Module.phpMysqlCall(op, link, bytes(a, a_length), bytes(b, b_length), bytes(c, c_length));
});

static unsigned int read_u32(const char **cursor)
{
    unsigned int value;
    memcpy(&value, *cursor, sizeof(value));
    *cursor += sizeof(value);
    return value;
}

static char *read_str(const char **cursor)
{
    unsigned int length = read_u32(cursor);
    char *text = (char *) *cursor;
    *cursor += length + 1;
    return text;
}

static void copy_text(char *to, size_t size, const char *from)
{
    strncpy(to, from ? from : "", size - 1);
    to[size - 1] = '\0';
}

#ifdef WASM_LIBMYSQL_API_55
static struct known_charset *find_charset(const char *csname)
{
    size_t i;
    for (i = 0; i < sizeof(known_charsets) / sizeof(known_charsets[0]); i++) {
        if (csname && strcmp(known_charsets[i].info.csname, csname) == 0) {
            return &known_charsets[i];
        }
    }
    return NULL;
}
#endif

/* MySQL's SQLSTATE for the errors mysql-sqlite.js and this client raise. */
static const char *sqlstate_of(unsigned int error_number)
{
    switch (error_number) {
        case 0: return "00000";
        case 1045: return "28000";
        case 1044: case 1049: case 1061: case 1064: case 1065: case 1091: case 1115:
            return "42000";
        case 1050: return "42S01";
        case 1051: case 1146: return "42S02";
        case 1054: return "42S22";
        case 1060: return "42S21";
        case 1048: case 1062: return "23000";
        case 1136: return "21S01";
        default: return UNKNOWN_SQLSTATE;
    }
}

static void clear_error(MYSQL *mysql)
{
    mysql->net.last_errno = 0;
    mysql->net.last_error[0] = '\0';
    strcpy(mysql->net.sqlstate, "00000");
}

static void set_error(MYSQL *mysql, unsigned int error_number, const char *message)
{
    mysql->net.last_errno = error_number;
    copy_text(mysql->net.last_error, sizeof(mysql->net.last_error), message);
    strcpy(mysql->net.sqlstate, sqlstate_of(error_number));
}

static char *call_server(MYSQL *mysql, int op, const char *a, size_t a_length,
    const char *b, size_t b_length, const char *c, size_t c_length)
{
    char *response = php_mysql_server_call(op, mysql ? mysql->link : 0,
        a, a_length, b, b_length, c, c_length);
    if (response == NULL && mysql != NULL) {
        if (op == OP_CONNECT) {
            set_error(mysql, CR_CONN_HOST_ERROR, "Can't connect to MySQL server (no server in this runtime)");
        } else {
            set_error(mysql, CR_SERVER_LOST, "Lost connection to MySQL server during query");
        }
    }
    return response;
}

static size_t length_of(const char *text)
{
    return text ? strlen(text) : 0;
}

#ifdef WASM_LIBMYSQL_API_55
/* What a 5.5 server says a column's charset is: binary for numbers, dates
   and binary strings, the connection's for the rest. */
static unsigned int charset_number_of(const MYSQL_FIELD *field, const char *connection_charset)
{
    const struct known_charset *charset = find_charset(connection_charset);
    switch (field->type) {
        case MYSQL_TYPE_VAR_STRING: case MYSQL_TYPE_STRING: case MYSQL_TYPE_VARCHAR:
        case MYSQL_TYPE_TINY_BLOB: case MYSQL_TYPE_MEDIUM_BLOB: case MYSQL_TYPE_LONG_BLOB:
        case MYSQL_TYPE_BLOB: case MYSQL_TYPE_ENUM: case MYSQL_TYPE_SET:
            if (!(field->flags & BINARY_FLAG) && charset) {
                return charset->info.number;
            }
            return BINARY_CHARSET_NUMBER;
        default:
            return BINARY_CHARSET_NUMBER;
    }
}
#endif

/* Reads a kind 2 response into a result set that owns the buffer. db and
   charset are the connection's, which a 5.5 client reports per field. */
static MYSQL_RES *read_result(char *response, const char *cursor, const char *db, const char *charset)
{
    MYSQL_RES *result = calloc(1, sizeof(MYSQL_RES));
    unsigned int field_count;
    unsigned int row_count;
    unsigned int field;
    unsigned int row;
    char **cells;
    unsigned long *lengths;

    if (result == NULL) {
        free(response);
        return NULL;
    }
    field_count = read_u32(&cursor);
    row_count = read_u32(&cursor);
    result->response = response;
    result->field_count = field_count;
    result->row_count = row_count;
    result->fields = calloc(field_count ? field_count : 1, sizeof(MYSQL_FIELD));
    result->rows = malloc((row_count ? row_count : 1) * sizeof(MYSQL_ROW));
    result->lengths = malloc((row_count ? row_count : 1) * sizeof(unsigned long *));
    result->db = strdup(db ? db : "");
    cells = malloc((row_count * field_count ? row_count * field_count : 1) * sizeof(char *));
    lengths = malloc((row_count * field_count ? row_count * field_count : 1) * sizeof(unsigned long));
    result->cells = cells;
    result->cell_lengths = lengths;
    if (!result->fields || !result->rows || !result->lengths || !result->db || !cells || !lengths) {
        result->response = NULL;
        mysql_free_result(result);
        free(response);
        return NULL;
    }

    for (field = 0; field < field_count; field++) {
        MYSQL_FIELD *f = &result->fields[field];
        f->name = read_str(&cursor);
        f->table = read_str(&cursor);
        f->def = read_str(&cursor);
        f->type = (enum enum_field_types) read_u32(&cursor);
        f->length = read_u32(&cursor);
        f->max_length = read_u32(&cursor);
        f->flags = read_u32(&cursor);
        f->decimals = read_u32(&cursor);
#ifdef WASM_LIBMYSQL_API_55
        /* No aliases or views here, so the original names are the names. */
        f->org_name = f->name;
        f->org_table = f->table;
        f->db = *f->table ? result->db : "";
        f->catalog = "def";
        f->name_length = strlen(f->name);
        f->org_name_length = f->name_length;
        f->table_length = strlen(f->table);
        f->org_table_length = f->table_length;
        f->db_length = strlen(f->db);
        f->catalog_length = 3;
        f->def_length = strlen(f->def);
        f->charsetnr = charset_number_of(f, charset);
#endif
    }
    for (row = 0; row < row_count; row++) {
        result->rows[row] = cells + (size_t) row * field_count;
        result->lengths[row] = lengths + (size_t) row * field_count;
        for (field = 0; field < field_count; field++) {
            unsigned int length = read_u32(&cursor);
            if (length == NULL_LENGTH) {
                result->rows[row][field] = NULL;
                result->lengths[row][field] = 0;
            } else {
                result->rows[row][field] = (char *) cursor;
                result->lengths[row][field] = length;
                cursor += length + 1;
            }
        }
    }
    return result;
}

static void discard_pending_result(MYSQL *mysql)
{
    if (mysql->pending_result) {
        mysql_free_result(mysql->pending_result);
        mysql->pending_result = NULL;
    }
    mysql->status = MYSQL_STATUS_READY;
}

/* Applies a query's response to the connection. Returns 0 on success. */
static int apply_query_response(MYSQL *mysql, char *response)
{
    const char *cursor = response;
    unsigned int kind;

    if (response == NULL) {
        return 1;
    }
    kind = read_u32(&cursor);
    if (kind == KIND_ERROR) {
        unsigned int error_number = read_u32(&cursor);
        set_error(mysql, error_number, read_str(&cursor));
        free(response);
        return 1;
    }
    if (kind == KIND_OK) {
        unsigned int low = read_u32(&cursor);
        unsigned int high = read_u32(&cursor);
        mysql->affected_rows = ((my_ulonglong) high << 32) | low;
        low = read_u32(&cursor);
        high = read_u32(&cursor);
        mysql->insert_id = ((my_ulonglong) high << 32) | low;
        mysql->field_count = 0;
        free(response);
        return 0;
    }
    if (kind == KIND_RESULT) {
        MYSQL_RES *result = read_result(response, cursor, mysql->db, mysql_character_set_name(mysql));
        if (result == NULL) {
            set_error(mysql, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
            return 1;
        }
        mysql->pending_result = result;
        mysql->status = MYSQL_STATUS_GET_RESULT;
        mysql->field_count = result->field_count;
        mysql->affected_rows = result->row_count;
        return 0;
    }
    free(response);
    set_error(mysql, CR_SERVER_LOST, "Lost connection to MySQL server during query");
    return 1;
}

MYSQL *mysql_init(MYSQL *mysql)
{
    my_bool free_me = 0;
    if (mysql == NULL) {
        mysql = malloc(sizeof(MYSQL));
        if (mysql == NULL) {
            return NULL;
        }
        free_me = 1;
    }
    memset(mysql, 0, sizeof(MYSQL));
    mysql->free_me = free_me;
    mysql->status = MYSQL_STATUS_READY;
    strcpy(mysql->net.sqlstate, "00000");
    return mysql;
}

/* Options are kept for what they change here: commands to run after each
   connect, and the charset to ask for. The rest are about a network. */
int mysql_options(MYSQL *mysql, enum mysql_option option, const void *arg)
{
    switch (option) {
        case MYSQL_INIT_COMMAND:
            if (arg == NULL || mysql->init_command_count >= WASM_LIBMYSQL_INIT_COMMANDS) {
                return 1;
            }
            mysql->init_commands[mysql->init_command_count] = strdup((const char *) arg);
            if (mysql->init_commands[mysql->init_command_count] == NULL) {
                return 1;
            }
            mysql->init_command_count++;
            break;
        case MYSQL_SET_CHARSET_NAME:
            free(mysql->option_charset);
            mysql->option_charset = arg ? strdup((const char *) arg) : NULL;
            break;
#ifdef WASM_LIBMYSQL_API_55
        case MYSQL_OPT_RECONNECT:
            mysql->reconnect = arg ? *(const my_bool *) arg : 0;
            break;
#endif
        default:
            break;
    }
    return 0;
}

static void close_link(MYSQL *mysql)
{
    discard_pending_result(mysql);
    if (mysql->link) {
        free(call_server(mysql, OP_CLOSE, NULL, 0, NULL, 0, NULL, 0));
        mysql->link = 0;
    }
}

/* Opens a link and sets the connection up as a real client's handshake and
   options would. Returns 0 on success, with the link open. */
static int open_link(MYSQL *mysql, const char *host, const char *user,
    const char *passwd, const char *db)
{
    char *response;
    const char *cursor;
    unsigned int kind;
    unsigned int i;

    clear_error(mysql);
    response = call_server(mysql, OP_CONNECT, host, length_of(host),
        user, length_of(user), passwd, length_of(passwd));
    if (response == NULL) {
        return 1;
    }
    cursor = response;
    kind = read_u32(&cursor);
    if (kind != KIND_LINK) {
        if (kind == KIND_ERROR) {
            unsigned int error_number = read_u32(&cursor);
            set_error(mysql, error_number, read_str(&cursor));
        } else {
            set_error(mysql, CR_CONN_HOST_ERROR, "Can't connect to MySQL server");
        }
        free(response);
        return 1;
    }
    mysql->link = read_u32(&cursor);
    copy_text(mysql->server_version, sizeof(mysql->server_version), read_str(&cursor));
    copy_text(mysql->host_info_buffer, sizeof(mysql->host_info_buffer), read_str(&cursor));
    copy_text(mysql->charset_name, sizeof(mysql->charset_name), read_str(&cursor));
#ifdef WASM_LIBMYSQL_API_55
    {
        struct known_charset *charset = find_charset(mysql->charset_name);
        mysql->charset = charset ? &charset->info : NULL;
    }
#endif
    mysql->host_info = mysql->host_info_buffer;
    copy_text(mysql->host, sizeof(mysql->host), host);
    mysql->db[0] = '\0';
    free(response);

    if (db != NULL && *db && mysql_select_db(mysql, db) != 0) {
        goto failed;
    }
#ifdef WASM_LIBMYSQL_API_55
    if (mysql->option_charset && mysql_set_character_set(mysql, mysql->option_charset) != 0) {
        goto failed;
    }
#endif
    for (i = 0; i < mysql->init_command_count; i++) {
        if (mysql_query(mysql, mysql->init_commands[i]) != 0) {
            goto failed;
        }
        discard_pending_result(mysql);
    }
    return 0;

failed:
    {
        unsigned int error_number = mysql->net.last_errno;
        char message[sizeof(mysql->net.last_error)];
        strcpy(message, mysql->net.last_error);
        close_link(mysql);
        set_error(mysql, error_number, message);
    }
    return 1;
}

MYSQL *mysql_real_connect(MYSQL *mysql, const char *host, const char *user,
    const char *passwd, const char *db, unsigned int port,
    const char *unix_socket, unsigned long client_flag)
{
    return open_link(mysql, host, user, passwd, db) == 0 ? mysql : NULL;
}

void mysql_close(MYSQL *mysql)
{
    unsigned int i;
    if (mysql == NULL) {
        return;
    }
    close_link(mysql);
    for (i = 0; i < mysql->init_command_count; i++) {
        free(mysql->init_commands[i]);
    }
    mysql->init_command_count = 0;
    free(mysql->option_charset);
    mysql->option_charset = NULL;
    if (mysql->free_me) {
        free(mysql);
    }
}

int mysql_select_db(MYSQL *mysql, const char *db)
{
    clear_error(mysql);
    if (apply_query_response(mysql,
            call_server(mysql, OP_SELECT_DB, db, length_of(db), NULL, 0, NULL, 0)) != 0) {
        return 1;
    }
    copy_text(mysql->db, sizeof(mysql->db), db);
    return 0;
}

int mysql_real_query(MYSQL *mysql, const char *q, unsigned long length)
{
    discard_pending_result(mysql);
    clear_error(mysql);
    mysql->affected_rows = 0;
    mysql->insert_id = 0;
    mysql->field_count = 0;
    return apply_query_response(mysql,
        call_server(mysql, OP_QUERY, q, length, NULL, 0, NULL, 0));
}

int mysql_query(MYSQL *mysql, const char *q)
{
    return mysql_real_query(mysql, q, strlen(q));
}

MYSQL_RES *mysql_store_result(MYSQL *mysql)
{
    MYSQL_RES *result = mysql->pending_result;
    mysql->pending_result = NULL;
    mysql->status = MYSQL_STATUS_READY;
    return result;
}

/* Every result is buffered here, so the unbuffered variant is the same. */
MYSQL_RES *mysql_use_result(MYSQL *mysql)
{
    return mysql_store_result(mysql);
}

void mysql_free_result(MYSQL_RES *result)
{
    if (result == NULL) {
        return;
    }
    free(result->cells);
    free(result->cell_lengths);
    free(result->rows);
    free(result->lengths);
    free(result->fields);
    free(result->db);
    free(result->response);
    free(result);
}

my_ulonglong mysql_num_rows(MYSQL_RES *res)
{
    return res->row_count;
}

unsigned int mysql_num_fields(MYSQL_RES *res)
{
    return res->field_count;
}

my_bool mysql_eof(MYSQL_RES *res)
{
    return res->eof;
}

unsigned int mysql_field_count(MYSQL *mysql)
{
    return mysql->field_count;
}

my_ulonglong mysql_affected_rows(MYSQL *mysql)
{
    return mysql->affected_rows;
}

my_ulonglong mysql_insert_id(MYSQL *mysql)
{
    return mysql->insert_id;
}

unsigned int mysql_errno(MYSQL *mysql)
{
    return mysql->net.last_errno;
}

char *mysql_error(MYSQL *mysql)
{
    return mysql->net.last_error;
}

unsigned long mysql_thread_id(MYSQL *mysql)
{
    return mysql->link;
}

MYSQL_ROW mysql_fetch_row(MYSQL_RES *result)
{
    if (result->next_row >= result->row_count) {
        result->eof = 1;
        result->current_row = NULL;
        result->current_lengths = NULL;
        return NULL;
    }
    result->current_row = result->rows[result->next_row];
    result->current_lengths = result->lengths[result->next_row];
    result->next_row++;
    return result->current_row;
}

unsigned long *mysql_fetch_lengths(MYSQL_RES *result)
{
    return result->current_lengths;
}

MYSQL_FIELD *mysql_fetch_field(MYSQL_RES *result)
{
    if (result->current_field >= result->field_count) {
        return NULL;
    }
    return &result->fields[result->current_field++];
}

MYSQL_FIELD_OFFSET mysql_field_seek(MYSQL_RES *result, MYSQL_FIELD_OFFSET offset)
{
    MYSQL_FIELD_OFFSET previous = result->current_field;
    result->current_field = offset;
    return previous;
}

void mysql_data_seek(MYSQL_RES *result, my_ulonglong offset)
{
    result->next_row = offset;
    result->eof = offset >= result->row_count;
}

static MYSQL_RES *query_with_wild(MYSQL *mysql, const char *statement, const char *wild)
{
    size_t statement_length = strlen(statement);
    size_t wild_length = length_of(wild);
    char *query = malloc(statement_length + 2 * wild_length + sizeof(" LIKE ''"));
    size_t length;

    if (query == NULL) {
        set_error(mysql, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return NULL;
    }
    memcpy(query, statement, statement_length);
    length = statement_length;
    if (wild != NULL && *wild) {
        memcpy(query + length, " LIKE '", 7);
        length += 7;
        length += mysql_escape_string(query + length, wild, wild_length);
        query[length++] = '\'';
    }
    query[length] = '\0';
    if (mysql_real_query(mysql, query, length) != 0) {
        free(query);
        return NULL;
    }
    free(query);
    return mysql_store_result(mysql);
}

MYSQL_RES *mysql_list_dbs(MYSQL *mysql, const char *wild)
{
    return query_with_wild(mysql, "SHOW DATABASES", wild);
}

MYSQL_RES *mysql_list_tables(MYSQL *mysql, const char *wild)
{
    return query_with_wild(mysql, "SHOW TABLES", wild);
}

MYSQL_RES *mysql_list_processes(MYSQL *mysql)
{
    return query_with_wild(mysql, "SHOW PROCESSLIST", NULL);
}

MYSQL_RES *mysql_list_fields(MYSQL *mysql, const char *table, const char *wild)
{
    MYSQL_RES *result;
    discard_pending_result(mysql);
    clear_error(mysql);
    if (apply_query_response(mysql, call_server(mysql, OP_LIST_FIELDS,
            table, length_of(table), wild, length_of(wild), NULL, 0)) != 0) {
        return NULL;
    }
    result = mysql_store_result(mysql);
    mysql->field_count = 0;
    return result;
}

char *mysql_get_client_info(void)
{
    return MYSQL_SERVER_VERSION;
}

/* MySQL 4.0 added this. PHP 5's ext/mysql calls it on every connect, and
   warns when its major and minor version differ from the header's. */
unsigned long mysql_get_client_version(void)
{
    return MYSQL_VERSION_ID;
}

char *mysql_get_server_info(MYSQL *mysql)
{
    return mysql->server_version;
}

char *mysql_get_host_info(MYSQL *mysql)
{
    return mysql->host_info_buffer;
}

unsigned int mysql_get_proto_info(MYSQL *mysql)
{
    return PROTOCOL_VERSION;
}

int mysql_ping(MYSQL *mysql)
{
    clear_error(mysql);
    return apply_query_response(mysql,
        call_server(mysql, OP_PING, NULL, 0, NULL, 0, NULL, 0));
}

/* The server answers COM_STATISTICS with a line of counters. There is no
   server process here to count, so this says what is answering instead. */
char *mysql_stat(MYSQL *mysql)
{
    if (mysql_ping(mysql) != 0) {
        return mysql->net.last_error;
    }
    return "Uptime: 0  Threads: 1  Questions: 0  Slow queries: 0  Opens: 0  Flush tables: 0  Open tables: 0 (SQLite in WebAssembly)";
}

char *mysql_info(MYSQL *mysql)
{
    return NULL;
}

/* The connection's charset: the server's until mysql_set_character_set()
   changes it. A SET NAMES sent as a query does not, as in the real client. */
const char *mysql_character_set_name(MYSQL *mysql)
{
    return mysql->charset_name[0] ? mysql->charset_name : "latin1";
}

unsigned long mysql_escape_string(char *to, const char *from, unsigned long from_length)
{
    char *start = to;
    const char *end = from + from_length;

    for (; from < end; from++) {
        char escape = 0;
        switch (*from) {
            case 0: escape = '0'; break;
            case '\n': escape = 'n'; break;
            case '\r': escape = 'r'; break;
            case '\\': escape = '\\'; break;
            case '\'': escape = '\''; break;
            case '"': escape = '"'; break;
            case '\032': escape = 'Z'; break;
        }
        if (escape) {
            *to++ = '\\';
            *to++ = escape;
        } else {
            *to++ = *from;
        }
    }
    *to = '\0';
    return (unsigned long) (to - start);
}

/* latin1 and utf8 are the only charsets here, and neither has a multibyte
   sequence that contains a byte this escapes, so bytes are escaped one by
   one whatever the connection's charset. */
unsigned long mysql_real_escape_string(MYSQL *mysql, char *to, const char *from, unsigned long length)
{
    return mysql_escape_string(to, from, length);
}

my_bool mysql_thread_init(void)
{
    return 0;
}

void mysql_thread_end(void)
{
}

#ifndef WASM_LIBMYSQL_API_55

MYSQL *mysql_connect(MYSQL *mysql, const char *host, const char *user, const char *passwd)
{
    return mysql_real_connect(mysql_init(mysql), host, user, passwd, NULL, 0, NULL, 0);
}

static int run_statement_on_name(MYSQL *mysql, const char *statement, const char *name)
{
    size_t statement_length = strlen(statement);
    size_t name_length = length_of(name);
    char *query = malloc(statement_length + name_length + 3);
    int failed;

    if (query == NULL) {
        set_error(mysql, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return 1;
    }
    memcpy(query, statement, statement_length);
    query[statement_length] = '`';
    memcpy(query + statement_length + 1, name, name_length);
    query[statement_length + 1 + name_length] = '`';
    query[statement_length + 2 + name_length] = '\0';
    failed = mysql_real_query(mysql, query, statement_length + name_length + 2);
    free(query);
    return failed;
}

int mysql_create_db(MYSQL *mysql, const char *db)
{
    return run_statement_on_name(mysql, "CREATE DATABASE ", db);
}

int mysql_drop_db(MYSQL *mysql, const char *db)
{
    return run_statement_on_name(mysql, "DROP DATABASE ", db);
}

#else

MYSQL_FIELD *mysql_fetch_field_direct(MYSQL_RES *res, unsigned int fieldnr)
{
    return fieldnr < res->field_count ? &res->fields[fieldnr] : NULL;
}

MYSQL_FIELD *mysql_fetch_fields(MYSQL_RES *res)
{
    return res->fields;
}

MYSQL_FIELD_OFFSET mysql_field_tell(MYSQL_RES *res)
{
    return res->current_field;
}

const char *mysql_sqlstate(MYSQL *mysql)
{
    return mysql->net.sqlstate;
}

/* mysql-sqlite.js reports errors, never warnings. */
unsigned int mysql_warning_count(MYSQL *mysql)
{
    return 0;
}

unsigned long mysql_get_server_version(MYSQL *mysql)
{
    unsigned long major = 0, minor = 0, patch = 0;
    sscanf(mysql->server_version, "%lu.%lu.%lu", &major, &minor, &patch);
    return major * 10000 + minor * 100 + patch;
}

/* As the real client: refuse a charset it does not know, then tell the
   server with SET NAMES. */
int mysql_set_character_set(MYSQL *mysql, const char *csname)
{
    char query[64];
    if (find_charset(csname) == NULL) {
        char message[MYSQL_ERRMSG_SIZE];
        snprintf(message, sizeof(message), "Can't initialize character set %s (path: compiled_in)", csname ? csname : "");
        set_error(mysql, CR_CANT_READ_CHARSET, message);
        return 1;
    }
    snprintf(query, sizeof(query), "SET NAMES %s", csname);
    if (mysql_query(mysql, query) != 0) {
        return 1;
    }
    copy_text(mysql->charset_name, sizeof(mysql->charset_name), csname);
    mysql->charset = &find_charset(csname)->info;
    return 0;
}

void mysql_get_character_set_info(MYSQL *mysql, MY_CHARSET_INFO *info)
{
    const struct known_charset *charset = find_charset(mysql_character_set_name(mysql));
    memset(info, 0, sizeof(*info));
    if (charset == NULL) {
        charset = &known_charsets[0];
    }
    info->number = charset->info.number;
    info->state = 1;
    info->csname = charset->info.csname;
    info->name = charset->info.name;
    info->comment = charset->comment;
    info->dir = NULL;
    info->mbminlen = 1;
    info->mbmaxlen = charset->mbmaxlen;
}

/* mysql-sqlite.js runs one statement per query, so multi-statements stay
   off whatever this says. */
int mysql_set_server_option(MYSQL *mysql, enum enum_mysql_set_option option)
{
    clear_error(mysql);
    return 0;
}

/* A new link for the new user, as the server would start a new session.
   On failure the old link stays, with its error. */
my_bool mysql_change_user(MYSQL *mysql, const char *user, const char *passwd, const char *db)
{
    MYSQL fresh;
    char host[sizeof(mysql->host)];
    unsigned int i;

    strcpy(host, mysql->host);
    mysql_init(&fresh);
    if (open_link(&fresh, host, user, passwd, db) != 0) {
        set_error(mysql, fresh.net.last_errno, fresh.net.last_error);
        return 1;
    }
    close_link(mysql);
    mysql->link = fresh.link;
    strcpy(mysql->db, fresh.db);
    strcpy(mysql->charset_name, fresh.charset_name);
    mysql->charset = fresh.charset;
    clear_error(mysql);
    for (i = 0; i < mysql->init_command_count; i++) {
        if (mysql_query(mysql, mysql->init_commands[i]) != 0) {
            return 1;
        }
        discard_pending_result(mysql);
    }
    return 0;
}

/* There is no network to encrypt. */
my_bool mysql_ssl_set(MYSQL *mysql, const char *key, const char *cert,
    const char *ca, const char *capath, const char *cipher)
{
    return 0;
}

my_bool mysql_autocommit(MYSQL *mysql, my_bool auto_mode)
{
    return mysql_query(mysql, auto_mode ? "SET autocommit=1" : "SET autocommit=0") != 0;
}

my_bool mysql_commit(MYSQL *mysql)
{
    return mysql_query(mysql, "COMMIT") != 0;
}

my_bool mysql_rollback(MYSQL *mysql)
{
    return mysql_query(mysql, "ROLLBACK") != 0;
}

my_bool mysql_more_results(MYSQL *mysql)
{
    return 0;
}

int mysql_next_result(MYSQL *mysql)
{
    return -1;
}

int mysql_refresh(MYSQL *mysql, unsigned int refresh_options)
{
    clear_error(mysql);
    return 0;
}

int mysql_kill(MYSQL *mysql, unsigned long pid)
{
    char query[32];
    snprintf(query, sizeof(query), "KILL %lu", pid);
    return mysql_query(mysql, query);
}

int mysql_dump_debug_info(MYSQL *mysql)
{
    clear_error(mysql);
    return 0;
}

void mysql_debug(const char *debug)
{
}

/* Built without threads, as PHP here is. */
unsigned int mysql_thread_safe(void)
{
    return 0;
}

int mysql_server_init(int argc, char **argv, char **groups)
{
    return 0;
}

void mysql_server_end(void)
{
}

/* --- prepared statements ------------------------------------------------ */

struct text_buffer {
    char *data;
    size_t length;
    size_t size;
};

static int text_reserve(struct text_buffer *text, size_t more)
{
    if (text->length + more + 1 > text->size) {
        size_t size = (text->length + more + 1) * 2;
        char *data = realloc(text->data, size);
        if (data == NULL) {
            return 1;
        }
        text->data = data;
        text->size = size;
    }
    return 0;
}

static int text_append(struct text_buffer *text, const char *bytes, size_t length)
{
    if (text_reserve(text, length)) {
        return 1;
    }
    memcpy(text->data + text->length, bytes, length);
    text->length += length;
    text->data[text->length] = '\0';
    return 0;
}

static int text_append_quoted(struct text_buffer *text, const char *bytes, size_t length)
{
    if (text_reserve(text, 2 * length + 2)) {
        return 1;
    }
    text->data[text->length++] = '\'';
    text->length += mysql_escape_string(text->data + text->length, bytes, length);
    text->data[text->length++] = '\'';
    text->data[text->length] = '\0';
    return 0;
}

static void clear_stmt_error(MYSQL_STMT *stmt)
{
    stmt->last_errno = 0;
    stmt->last_error[0] = '\0';
    strcpy(stmt->sqlstate, "00000");
}

static void set_stmt_error(MYSQL_STMT *stmt, unsigned int error_number, const char *message)
{
    stmt->last_errno = error_number;
    copy_text(stmt->last_error, sizeof(stmt->last_error), message);
    strcpy(stmt->sqlstate, sqlstate_of(error_number));
}

static void copy_error_to_stmt(MYSQL_STMT *stmt)
{
    stmt->last_errno = stmt->mysql->net.last_errno;
    strcpy(stmt->last_error, stmt->mysql->net.last_error);
    strcpy(stmt->sqlstate, stmt->mysql->net.sqlstate);
}

static void free_long_data(MYSQL_STMT *stmt)
{
    unsigned int i;
    if (stmt->long_data) {
        for (i = 0; i < stmt->param_count; i++) {
            free(stmt->long_data[i]);
        }
    }
    free(stmt->long_data);
    free(stmt->long_data_length);
    stmt->long_data = NULL;
    stmt->long_data_length = NULL;
    if (stmt->params) {
        for (i = 0; i < stmt->param_count; i++) {
            stmt->params[i].long_data_used = 0;
        }
    }
}

static void free_stmt_fields(MYSQL_STMT *stmt)
{
    free(stmt->fields);
    free(stmt->field_strings);
    stmt->fields = NULL;
    stmt->field_strings = NULL;
    stmt->field_count = 0;
}

/* The statement keeps its own copy of the columns, so mysqli can read
   stmt->fields across mysql_stmt_free_result() and the next execute. */
static int copy_stmt_fields(MYSQL_STMT *stmt, const MYSQL_RES *result, my_bool with_max_length)
{
    unsigned int i;
    size_t size = 0;
    char *strings;
    MYSQL_FIELD *fields;

    free_stmt_fields(stmt);
    if (result->field_count == 0) {
        return 0;
    }
    for (i = 0; i < result->field_count; i++) {
        const MYSQL_FIELD *f = &result->fields[i];
        size += strlen(f->name) + strlen(f->table) + strlen(f->db) + strlen(f->def) + 4;
    }
    fields = malloc(result->field_count * sizeof(MYSQL_FIELD));
    strings = malloc(size ? size : 1);
    if (fields == NULL || strings == NULL) {
        free(fields);
        free(strings);
        return 1;
    }
    stmt->fields = fields;
    stmt->field_strings = strings;
    stmt->field_count = result->field_count;
    for (i = 0; i < result->field_count; i++) {
        MYSQL_FIELD *f = &fields[i];
        *f = result->fields[i];
        f->name = strcpy(strings, result->fields[i].name);
        strings += strlen(strings) + 1;
        f->table = strcpy(strings, result->fields[i].table);
        strings += strlen(strings) + 1;
        f->db = strcpy(strings, result->fields[i].db);
        strings += strlen(strings) + 1;
        f->def = strcpy(strings, result->fields[i].def);
        strings += strlen(strings) + 1;
        f->org_name = f->name;
        f->org_table = f->table;
        f->catalog = "def";
        if (!with_max_length) {
            f->max_length = 0;
        }
    }
    return 0;
}

static void free_stmt_result(MYSQL_STMT *stmt)
{
    mysql_free_result(stmt->result);
    stmt->result = NULL;
    stmt->current_row = 0;
}

/* Where each placeholder is: every ? outside quoted strings, quoted names
   and comments, as the server's parser would find it. */
static unsigned int find_placeholders(const char *query, unsigned long length, unsigned long *offsets)
{
    unsigned int count = 0;
    unsigned long i = 0;
    while (i < length) {
        char c = query[i];
        if (c == '\'' || c == '"' || c == '`') {
            char quote = c;
            i++;
            while (i < length) {
                if (query[i] == '\\' && quote != '`' && i + 1 < length) {
                    i += 2;
                } else if (query[i] == quote) {
                    if (i + 1 < length && query[i + 1] == quote) {
                        i += 2;
                    } else {
                        break;
                    }
                } else {
                    i++;
                }
            }
            i++;
        } else if (c == '#' || (c == '-' && i + 2 < length && query[i + 1] == '-'
                && (query[i + 2] == ' ' || query[i + 2] == '\t' || query[i + 2] == '\n'))) {
            while (i < length && query[i] != '\n') {
                i++;
            }
        } else if (c == '/' && i + 1 < length && query[i + 1] == '*') {
            i += 2;
            while (i + 1 < length && !(query[i] == '*' && query[i + 1] == '/')) {
                i++;
            }
            i += 2;
        } else {
            if (c == '?') {
                if (offsets) {
                    offsets[count] = i;
                }
                count++;
            }
            i++;
        }
    }
    return count;
}

/* Whether a statement starts with SELECT, after any opening parentheses,
   blanks and comments. */
static int starts_with_select(const char *query, unsigned long length)
{
    unsigned long i = 0;
    for (;;) {
        while (i < length && (query[i] == ' ' || query[i] == '\t' || query[i] == '\n'
                || query[i] == '\r' || query[i] == '(')) {
            i++;
        }
        if (i + 1 < length && query[i] == '/' && query[i + 1] == '*') {
            i += 2;
            while (i + 1 < length && !(query[i] == '*' && query[i + 1] == '/')) {
                i++;
            }
            i += 2;
            continue;
        }
        break;
    }
    if (length - i < 6 || strncasecmp(query + i, "SELECT", 6) != 0) {
        return 0;
    }
    return i + 6 == length || !(query[i + 6] == '_' || (query[i + 6] >= '0' && query[i + 6] <= '9')
        || ((query[i + 6] | 32) >= 'a' && (query[i + 6] | 32) <= 'z'));
}

/* One bound value as an SQL literal. */
static int append_param(MYSQL_STMT *stmt, struct text_buffer *text, unsigned int i)
{
    MYSQL_BIND *param = &stmt->params[i];
    char number[64];
    unsigned long length;

    if (stmt->long_data && stmt->long_data[i]) {
        return text_append_quoted(text, stmt->long_data[i], stmt->long_data_length[i]);
    }
    if (param->buffer_type == MYSQL_TYPE_NULL || (param->is_null && *param->is_null)) {
        return text_append(text, "NULL", 4);
    }
    switch (param->buffer_type) {
        case MYSQL_TYPE_TINY:
            if (param->is_unsigned) {
                snprintf(number, sizeof(number), "%u", (unsigned int) *(unsigned char *) param->buffer);
            } else {
                snprintf(number, sizeof(number), "%d", (int) *(signed char *) param->buffer);
            }
            break;
        case MYSQL_TYPE_SHORT:
            if (param->is_unsigned) {
                snprintf(number, sizeof(number), "%u", (unsigned int) *(unsigned short *) param->buffer);
            } else {
                snprintf(number, sizeof(number), "%d", (int) *(short *) param->buffer);
            }
            break;
        case MYSQL_TYPE_LONG:
        case MYSQL_TYPE_INT24:
            if (param->is_unsigned) {
                snprintf(number, sizeof(number), "%u", *(unsigned int *) param->buffer);
            } else {
                snprintf(number, sizeof(number), "%d", *(int *) param->buffer);
            }
            break;
        case MYSQL_TYPE_LONGLONG:
            if (param->is_unsigned) {
                snprintf(number, sizeof(number), "%llu", *(unsigned long long *) param->buffer);
            } else {
                snprintf(number, sizeof(number), "%lld", *(long long *) param->buffer);
            }
            break;
        case MYSQL_TYPE_FLOAT:
            snprintf(number, sizeof(number), "%.9g", (double) *(float *) param->buffer);
            break;
        case MYSQL_TYPE_DOUBLE:
            snprintf(number, sizeof(number), "%.17g", *(double *) param->buffer);
            break;
        default:
            length = param->length ? *param->length : param->buffer_length;
            return text_append_quoted(text, param->buffer ? (const char *) param->buffer : "",
                param->buffer ? length : 0);
    }
    return text_append(text, number, strlen(number));
}

/* The statement's SQL with each placeholder replaced: by its bound value,
   or by NULL when params is 0. */
static char *substitute(MYSQL_STMT *stmt, int with_params, unsigned long *length)
{
    struct text_buffer text = { NULL, 0, 0 };
    unsigned long from = 0;
    unsigned long query_length = strlen(stmt->query);
    unsigned int i;

    for (i = 0; i < stmt->param_count; i++) {
        if (text_append(&text, stmt->query + from, stmt->placeholders[i] - from)
                || (with_params ? append_param(stmt, &text, i) : text_append(&text, "NULL", 4))) {
            free(text.data);
            return NULL;
        }
        from = stmt->placeholders[i] + 1;
    }
    if (text_append(&text, stmt->query + from, query_length - from)) {
        free(text.data);
        return NULL;
    }
    *length = text.length;
    return text.data;
}

static void reset_prepared(MYSQL_STMT *stmt)
{
    free_long_data(stmt);
    free_stmt_result(stmt);
    free_stmt_fields(stmt);
    free(stmt->query);
    free(stmt->placeholders);
    free(stmt->params);
    free(stmt->bind);
    stmt->query = NULL;
    stmt->placeholders = NULL;
    stmt->params = NULL;
    stmt->bind = NULL;
    stmt->param_count = 0;
    stmt->affected_rows = 0;
    stmt->insert_id = 0;
}

/* What mysqli shows as a statement's id. */
static unsigned long next_stmt_id = 1;

MYSQL_STMT *mysql_stmt_init(MYSQL *mysql)
{
    MYSQL_STMT *stmt = calloc(1, sizeof(MYSQL_STMT));
    if (stmt == NULL) {
        set_error(mysql, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return NULL;
    }
    stmt->mysql = mysql;
    stmt->stmt_id = next_stmt_id++;
    strcpy(stmt->sqlstate, "00000");
    return stmt;
}

int mysql_stmt_prepare(MYSQL_STMT *stmt, const char *query, unsigned long length)
{
    MYSQL *mysql = stmt->mysql;

    reset_prepared(stmt);
    clear_stmt_error(stmt);
    stmt->query = malloc(length + 1);
    if (stmt->query == NULL) {
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return 1;
    }
    memcpy(stmt->query, query, length);
    stmt->query[length] = '\0';
    stmt->param_count = find_placeholders(stmt->query, length, NULL);
    stmt->placeholders = malloc((stmt->param_count ? stmt->param_count : 1) * sizeof(unsigned long));
    if (stmt->placeholders == NULL) {
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return 1;
    }
    find_placeholders(stmt->query, length, stmt->placeholders);

    /* A server checks a statement and describes a SELECT's columns when it
       prepares it. Here a SELECT is run with NULL for every placeholder,
       which changes nothing: an unknown table or column fails the prepare,
       as on a server. A syntax error does not, since NULL can cause one
       where the value could not (LIMIT NULL); it shows at the execute, with
       the columns. Other statements are checked at their execute. */
    if (starts_with_select(stmt->query, length)) {
        unsigned long sql_length;
        char *sql = substitute(stmt, 0, &sql_length);
        int failed = 0;
        if (sql == NULL) {
            set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
            return 1;
        }
        if (mysql_real_query(mysql, sql, sql_length) != 0) {
            if (mysql->net.last_errno != ER_PARSE_ERROR) {
                copy_error_to_stmt(stmt);
                failed = 1;
            }
        } else if (mysql->pending_result) {
            MYSQL_RES *result = mysql_store_result(mysql);
            copy_stmt_fields(stmt, result, 0);
            mysql_free_result(result);
        }
        free(sql);
        discard_pending_result(mysql);
        clear_error(mysql);
        if (failed) {
            return 1;
        }
    }
    return 0;
}

my_bool mysql_stmt_bind_param(MYSQL_STMT *stmt, MYSQL_BIND *bnd)
{
    unsigned int i;

    if (stmt->query == NULL) {
        set_stmt_error(stmt, CR_NO_PREPARE_STMT, "Statement not prepared");
        return 1;
    }
    free(stmt->params);
    stmt->params = NULL;
    if (stmt->param_count == 0) {
        return 0;
    }
    stmt->params = malloc(stmt->param_count * sizeof(MYSQL_BIND));
    if (stmt->params == NULL) {
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return 1;
    }
    memcpy(stmt->params, bnd, stmt->param_count * sizeof(MYSQL_BIND));
    for (i = 0; i < stmt->param_count; i++) {
        MYSQL_BIND *param = &stmt->params[i];
        param->param_number = i;
        param->long_data_used = stmt->long_data && stmt->long_data[i];
        switch (param->buffer_type) {
            case MYSQL_TYPE_TIME: case MYSQL_TYPE_DATE:
            case MYSQL_TYPE_DATETIME: case MYSQL_TYPE_TIMESTAMP: {
                /* Those take a MYSQL_TIME, which mysqli never binds. */
                char message[MYSQL_ERRMSG_SIZE];
                snprintf(message, sizeof(message), "Using unsupported buffer type: %d  (parameter: %u)",
                    (int) param->buffer_type, i + 1);
                set_stmt_error(stmt, CR_UNSUPPORTED_PARAM_TYPE, message);
                free(stmt->params);
                stmt->params = NULL;
                return 1;
            }
            default:
                break;
        }
    }
    clear_stmt_error(stmt);
    return 0;
}

my_bool mysql_stmt_send_long_data(MYSQL_STMT *stmt, unsigned int param_number,
    const char *data, unsigned long length)
{
    char *grown;

    if (param_number >= stmt->param_count) {
        set_stmt_error(stmt, CR_INVALID_PARAMETER_NO, "Invalid parameter number");
        return 1;
    }
    if (stmt->long_data == NULL) {
        stmt->long_data = calloc(stmt->param_count, sizeof(char *));
        stmt->long_data_length = calloc(stmt->param_count, sizeof(unsigned long));
        if (stmt->long_data == NULL || stmt->long_data_length == NULL) {
            free(stmt->long_data);
            free(stmt->long_data_length);
            stmt->long_data = NULL;
            stmt->long_data_length = NULL;
            set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
            return 1;
        }
    }
    grown = realloc(stmt->long_data[param_number], stmt->long_data_length[param_number] + length + 1);
    if (grown == NULL) {
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return 1;
    }
    memcpy(grown + stmt->long_data_length[param_number], data, length);
    stmt->long_data_length[param_number] += length;
    stmt->long_data[param_number] = grown;
    if (stmt->params) {
        stmt->params[param_number].long_data_used = 1;
    }
    return 0;
}

int mysql_stmt_execute(MYSQL_STMT *stmt)
{
    MYSQL *mysql = stmt->mysql;
    unsigned long length;
    char *sql;
    int failed;

    clear_stmt_error(stmt);
    if (stmt->query == NULL) {
        set_stmt_error(stmt, CR_NO_PREPARE_STMT, "Statement not prepared");
        return 1;
    }
    if (stmt->param_count && stmt->params == NULL) {
        set_stmt_error(stmt, CR_PARAMS_NOT_BOUND, "No data supplied for parameters in prepared statement");
        return 1;
    }
    sql = substitute(stmt, 1, &length);
    /* Data sent with mysql_stmt_send_long_data() is for one execute. */
    free_long_data(stmt);
    if (sql == NULL) {
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return 1;
    }
    free_stmt_result(stmt);
    failed = mysql_real_query(mysql, sql, length);
    free(sql);
    if (failed) {
        copy_error_to_stmt(stmt);
        return 1;
    }
    if (mysql->pending_result) {
        stmt->result = mysql_store_result(mysql);
        if (copy_stmt_fields(stmt, stmt->result, 1)) {
            free_stmt_result(stmt);
            set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
            return 1;
        }
        stmt->affected_rows = stmt->result->row_count;
        stmt->insert_id = 0;
    } else {
        stmt->affected_rows = mysql->affected_rows;
        stmt->insert_id = mysql->insert_id;
    }
    return 0;
}

/* The rows are in memory once executed, so this is where max_length was
   already set: the server measured every column. */
int mysql_stmt_store_result(MYSQL_STMT *stmt)
{
    clear_stmt_error(stmt);
    return 0;
}

my_bool mysql_stmt_bind_result(MYSQL_STMT *stmt, MYSQL_BIND *bnd)
{
    unsigned int i;

    if (stmt->field_count == 0) {
        set_stmt_error(stmt, CR_NO_STMT_METADATA, "Prepared statement contains no metadata");
        return 1;
    }
    free(stmt->bind);
    stmt->bind = malloc(stmt->field_count * sizeof(MYSQL_BIND));
    if (stmt->bind == NULL) {
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return 1;
    }
    memcpy(stmt->bind, bnd, stmt->field_count * sizeof(MYSQL_BIND));
    for (i = 0; i < stmt->field_count; i++) {
        MYSQL_BIND *bind = &stmt->bind[i];
        if (bind->is_null == NULL) {
            bind->is_null = &bind->is_null_value;
        }
        if (bind->length == NULL) {
            bind->length = &bind->length_value;
        }
        if (bind->error == NULL) {
            bind->error = &bind->error_value;
        }
        bind->param_number = i;
    }
    clear_stmt_error(stmt);
    return 0;
}

static unsigned long long text_to_unsigned(const char *text, unsigned long length)
{
    char digits[32];
    copy_text(digits, length + 1 < sizeof(digits) ? length + 1 : sizeof(digits), text);
    return strtoull(digits, NULL, 10);
}

static long long text_to_signed(const char *text, unsigned long length)
{
    char digits[32];
    copy_text(digits, length + 1 < sizeof(digits) ? length + 1 : sizeof(digits), text);
    return strtoll(digits, NULL, 10);
}

static double text_to_double(const char *text, unsigned long length)
{
    char digits[64];
    copy_text(digits, length + 1 < sizeof(digits) ? length + 1 : sizeof(digits), text);
    return strtod(digits, NULL);
}

/* One column's text, as a server would have sent it for the buffer's
   type. Returns 1 when a string did not fit. */
static int fetch_column(MYSQL_BIND *bind, const MYSQL_FIELD *field, const char *cell, unsigned long length)
{
    *bind->error = 0;
    if (cell == NULL) {
        *bind->is_null = 1;
        return 0;
    }
    *bind->is_null = 0;
    switch (bind->buffer_type) {
        case MYSQL_TYPE_NULL:
            *bind->is_null = 1;
            return 0;
        case MYSQL_TYPE_TINY:
            *(signed char *) bind->buffer = (signed char) text_to_signed(cell, length);
            *bind->length = 1;
            return 0;
        case MYSQL_TYPE_SHORT:
        case MYSQL_TYPE_YEAR:
            *(short *) bind->buffer = (short) text_to_signed(cell, length);
            *bind->length = 2;
            return 0;
        case MYSQL_TYPE_LONG:
        case MYSQL_TYPE_INT24:
            if (bind->is_unsigned) {
                *(unsigned int *) bind->buffer = (unsigned int) text_to_unsigned(cell, length);
            } else {
                *(int *) bind->buffer = (int) text_to_signed(cell, length);
            }
            *bind->length = 4;
            return 0;
        case MYSQL_TYPE_LONGLONG:
            if (bind->is_unsigned || (field->flags & UNSIGNED_FLAG)) {
                *(unsigned long long *) bind->buffer = text_to_unsigned(cell, length);
            } else {
                *(long long *) bind->buffer = text_to_signed(cell, length);
            }
            *bind->length = 8;
            return 0;
        case MYSQL_TYPE_FLOAT:
            *(float *) bind->buffer = (float) text_to_double(cell, length);
            *bind->length = 4;
            return 0;
        case MYSQL_TYPE_DOUBLE:
            *(double *) bind->buffer = text_to_double(cell, length);
            *bind->length = 8;
            return 0;
        case MYSQL_TYPE_BIT: {
            /* Big-endian, in as many bytes as the column has bits for. */
            unsigned long long value = text_to_unsigned(cell, length);
            unsigned long bytes = (field->length + 7) / 8;
            unsigned long i;
            if (bytes < 1) {
                bytes = 1;
            }
            if (bytes > 8) {
                bytes = 8;
            }
            for (i = 0; i < bytes && i < bind->buffer_length; i++) {
                ((unsigned char *) bind->buffer)[i] = (unsigned char) (value >> (8 * (bytes - 1 - i)));
            }
            *bind->length = bytes;
            return 0;
        }
        default: {
            unsigned long copied = length < bind->buffer_length ? length : bind->buffer_length;
            memcpy(bind->buffer, cell, copied);
            if (copied < bind->buffer_length) {
                ((char *) bind->buffer)[copied] = '\0';
            }
            *bind->length = length;
            if (length > bind->buffer_length) {
                *bind->error = 1;
                return 1;
            }
            return 0;
        }
    }
}

int mysql_stmt_fetch(MYSQL_STMT *stmt)
{
    MYSQL_ROW row;
    unsigned long *lengths;
    unsigned int i;
    int truncated = 0;

    if (stmt->result == NULL || stmt->current_row >= stmt->result->row_count) {
        return MYSQL_NO_DATA;
    }
    row = stmt->result->rows[stmt->current_row];
    lengths = stmt->result->lengths[stmt->current_row];
    stmt->current_row++;
    if (stmt->bind == NULL) {
        return 0;
    }
    for (i = 0; i < stmt->field_count; i++) {
        truncated |= fetch_column(&stmt->bind[i], &stmt->fields[i], row[i], lengths[i]);
    }
    return truncated ? MYSQL_DATA_TRUNCATED : 0;
}

unsigned long mysql_stmt_param_count(MYSQL_STMT *stmt)
{
    return stmt->param_count;
}

unsigned int mysql_stmt_field_count(MYSQL_STMT *stmt)
{
    return stmt->field_count;
}

my_bool mysql_stmt_attr_set(MYSQL_STMT *stmt, enum enum_stmt_attr_type attr_type, const void *attr)
{
    switch (attr_type) {
        case STMT_ATTR_UPDATE_MAX_LENGTH:
            stmt->update_max_length = attr ? *(const my_bool *) attr : 0;
            return 0;
        case STMT_ATTR_CURSOR_TYPE:
            stmt->cursor_type = attr ? *(const unsigned long *) attr : 0;
            return 0;
        case STMT_ATTR_PREFETCH_ROWS:
            stmt->prefetch_rows = attr ? *(const unsigned long *) attr : 1;
            return 0;
        default:
            set_stmt_error(stmt, CR_NOT_IMPLEMENTED, "This feature is not implemented yet");
            return 1;
    }
}

my_bool mysql_stmt_attr_get(MYSQL_STMT *stmt, enum enum_stmt_attr_type attr_type, void *attr)
{
    switch (attr_type) {
        case STMT_ATTR_UPDATE_MAX_LENGTH:
            *(my_bool *) attr = stmt->update_max_length;
            return 0;
        case STMT_ATTR_CURSOR_TYPE:
            *(unsigned long *) attr = stmt->cursor_type;
            return 0;
        case STMT_ATTR_PREFETCH_ROWS:
            *(unsigned long *) attr = stmt->prefetch_rows;
            return 0;
        default:
            return 1;
    }
}

/* Clears what was sent with mysql_stmt_send_long_data() and the error.
   Bindings and stored rows stay, as in the real client. */
my_bool mysql_stmt_reset(MYSQL_STMT *stmt)
{
    free_long_data(stmt);
    clear_stmt_error(stmt);
    stmt->current_row = 0;
    return 0;
}

my_bool mysql_stmt_free_result(MYSQL_STMT *stmt)
{
    free_stmt_result(stmt);
    return 0;
}

my_bool mysql_stmt_close(MYSQL_STMT *stmt)
{
    if (stmt == NULL) {
        return 0;
    }
    reset_prepared(stmt);
    free(stmt);
    return 0;
}

/* The columns without rows, in a result of its own whose MYSQL_FIELDs
   point into the statement's. */
MYSQL_RES *mysql_stmt_result_metadata(MYSQL_STMT *stmt)
{
    MYSQL_RES *result;
    if (stmt->field_count == 0) {
        return NULL;
    }
    result = calloc(1, sizeof(MYSQL_RES));
    if (result == NULL) {
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return NULL;
    }
    result->fields = malloc(stmt->field_count * sizeof(MYSQL_FIELD));
    if (result->fields == NULL) {
        free(result);
        set_stmt_error(stmt, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
        return NULL;
    }
    memcpy(result->fields, stmt->fields, stmt->field_count * sizeof(MYSQL_FIELD));
    result->field_count = stmt->field_count;
    result->eof = 1;
    return result;
}

unsigned int mysql_stmt_errno(MYSQL_STMT *stmt)
{
    return stmt->last_errno;
}

const char *mysql_stmt_error(MYSQL_STMT *stmt)
{
    return stmt->last_error;
}

const char *mysql_stmt_sqlstate(MYSQL_STMT *stmt)
{
    return stmt->sqlstate;
}

void mysql_stmt_data_seek(MYSQL_STMT *stmt, my_ulonglong offset)
{
    stmt->current_row = offset;
}

my_ulonglong mysql_stmt_num_rows(MYSQL_STMT *stmt)
{
    return stmt->result ? stmt->result->row_count : 0;
}

my_ulonglong mysql_stmt_affected_rows(MYSQL_STMT *stmt)
{
    return stmt->affected_rows;
}

my_ulonglong mysql_stmt_insert_id(MYSQL_STMT *stmt)
{
    return stmt->insert_id;
}

int mysql_stmt_next_result(MYSQL_STMT *stmt)
{
    return -1;
}

#endif
