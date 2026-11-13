/*
 * A MySQL 3.23 client library whose "server" is JS: every call that would go
 * over the wire goes to Module.phpMysqlCall (runtime/php-runtime.js), which
 * hands it to runtime/mysql-sqlite.js.
 *
 * The answer comes back as one malloc'd buffer:
 *
 *   u32 kind: 0 error, 1 ok, 2 result set, 3 link
 *   error:  u32 errno, str message
 *   ok:     u32 affected (low, high), u32 insert id (low, high), str info
 *   link:   u32 link id, str server version, str host info
 *   result: u32 field count, u32 row count,
 *           per field: str name, str table, str def,
 *                      u32 type, length, max_length, flags, decimals,
 *           per row, per field: u32 length (0xFFFFFFFF for NULL), bytes, NUL
 *   str:    u32 length, bytes, NUL
 *
 * Integers are little-endian, as in wasm memory. Strings are NUL-terminated
 * in place, so MYSQL_ROW cells and field names point into the buffer, which a
 * result set owns until mysql_free_result().
 */

#include <stdlib.h>
#include <string.h>
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

/* Client error codes and texts as in 3.23's errmsg.c. */
#define CR_CONN_HOST_ERROR 2003
#define CR_SERVER_LOST 2013
#define CR_OUT_OF_MEMORY 2008

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

static void clear_error(MYSQL *mysql)
{
    mysql->last_errno = 0;
    mysql->last_error[0] = '\0';
}

static void set_error(MYSQL *mysql, unsigned int error_number, const char *message)
{
    mysql->last_errno = error_number;
    strncpy(mysql->last_error, message, sizeof(mysql->last_error) - 1);
    mysql->last_error[sizeof(mysql->last_error) - 1] = '\0';
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

/* Reads a kind 2 response into a result set that owns the buffer. */
static MYSQL_RES *read_result(char *response, const char *cursor)
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
    cells = malloc((row_count * field_count ? row_count * field_count : 1) * sizeof(char *));
    lengths = malloc((row_count * field_count ? row_count * field_count : 1) * sizeof(unsigned long));
    result->cells = cells;
    result->cell_lengths = lengths;
    if (!result->fields || !result->rows || !result->lengths || !cells || !lengths) {
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
        MYSQL_RES *result = read_result(response, cursor);
        if (result == NULL) {
            set_error(mysql, CR_OUT_OF_MEMORY, "MySQL client run out of memory");
            return 1;
        }
        mysql->pending_result = result;
        mysql->field_count = result->field_count;
        mysql->affected_rows = result->row_count;
        return 0;
    }
    free(response);
    set_error(mysql, CR_SERVER_LOST, "Lost connection to MySQL server during query");
    return 1;
}

static void discard_pending_result(MYSQL *mysql)
{
    if (mysql->pending_result) {
        mysql_free_result(mysql->pending_result);
        mysql->pending_result = NULL;
    }
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
    return mysql;
}

int mysql_options(MYSQL *mysql, enum mysql_option option, const char *arg)
{
    return 0;
}

MYSQL *mysql_real_connect(MYSQL *mysql, const char *host, const char *user,
    const char *passwd, const char *db, unsigned int port,
    const char *unix_socket, unsigned int client_flag)
{
    char *response;
    const char *cursor;
    unsigned int kind;

    clear_error(mysql);
    response = call_server(mysql, OP_CONNECT, host, length_of(host),
        user, length_of(user), passwd, length_of(passwd));
    if (response == NULL) {
        return NULL;
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
        return NULL;
    }
    mysql->link = read_u32(&cursor);
    strncpy(mysql->server_version, read_str(&cursor), sizeof(mysql->server_version) - 1);
    strncpy(mysql->host_info, read_str(&cursor), sizeof(mysql->host_info) - 1);
    free(response);

    if (db != NULL && *db && mysql_select_db(mysql, db) != 0) {
        unsigned int error_number = mysql->last_errno;
        char message[sizeof(mysql->last_error)];
        strcpy(message, mysql->last_error);
        call_server(mysql, OP_CLOSE, NULL, 0, NULL, 0, NULL, 0);
        mysql->link = 0;
        set_error(mysql, error_number, message);
        return NULL;
    }
    return mysql;
}

MYSQL *mysql_connect(MYSQL *mysql, const char *host, const char *user, const char *passwd)
{
    return mysql_real_connect(mysql_init(mysql), host, user, passwd, NULL, 0, NULL, 0);
}

void mysql_close(MYSQL *mysql)
{
    if (mysql == NULL) {
        return;
    }
    discard_pending_result(mysql);
    if (mysql->link) {
        free(call_server(mysql, OP_CLOSE, NULL, 0, NULL, 0, NULL, 0));
        mysql->link = 0;
    }
    if (mysql->free_me) {
        free(mysql);
    }
}

int mysql_select_db(MYSQL *mysql, const char *db)
{
    clear_error(mysql);
    return apply_query_response(mysql,
        call_server(mysql, OP_SELECT_DB, db, length_of(db), NULL, 0, NULL, 0));
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
    return mysql->last_errno;
}

char *mysql_error(MYSQL *mysql)
{
    return mysql->last_error;
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

char *mysql_get_client_info(void)
{
    return MYSQL_SERVER_VERSION;
}

char *mysql_get_server_info(MYSQL *mysql)
{
    return mysql->server_version;
}

char *mysql_get_host_info(MYSQL *mysql)
{
    return mysql->host_info;
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

/* 3.23 answers COM_STATISTICS with a line of counters. There is no server
   process here to count, so this says what is answering instead. */
char *mysql_stat(MYSQL *mysql)
{
    if (mysql_ping(mysql) != 0) {
        return mysql->last_error;
    }
    return "Uptime: 0  Threads: 1  Questions: 0  Slow queries: 0  Opens: 0  Flush tables: 0  Open tables: 0 (SQLite in WebAssembly)";
}

char *mysql_info(MYSQL *mysql)
{
    return NULL;
}

const char *mysql_character_set_name(MYSQL *mysql)
{
    return "latin1";
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
