/*
 * The MySQL 3.23 client API, for PHP 4.4.9's own ext/mysql, answered by
 * runtime/mysql-sqlite.js instead of a server.
 *
 * Only what ext/mysql/php_mysql.c uses is declared. Names, type codes, flags
 * and the MYSQL_FIELD layout follow the 3.23.49 client PHP 4.4.9 bundles,
 * because php_mysql.c is compiled against them. The MYSQL and MYSQL_RES
 * structs are this library's own: php_mysql.c embeds MYSQL by value but only
 * reaches into it through the functions below.
 */

#ifndef PHP4_WASM_MYSQL_H
#define PHP4_WASM_MYSQL_H

#define MYSQL_SERVER_VERSION "3.23.49"
#define MYSQL_VERSION_ID 32349
#define PROTOCOL_VERSION 10
#define MYSQL_PORT 3306
#define MYSQL_UNIX_ADDR "/tmp/mysql.sock"

typedef char my_bool;
typedef unsigned long long my_ulonglong;
typedef char **MYSQL_ROW;
typedef unsigned int MYSQL_FIELD_OFFSET;

enum enum_field_types {
    FIELD_TYPE_DECIMAL, FIELD_TYPE_TINY,
    FIELD_TYPE_SHORT, FIELD_TYPE_LONG,
    FIELD_TYPE_FLOAT, FIELD_TYPE_DOUBLE,
    FIELD_TYPE_NULL, FIELD_TYPE_TIMESTAMP,
    FIELD_TYPE_LONGLONG, FIELD_TYPE_INT24,
    FIELD_TYPE_DATE, FIELD_TYPE_TIME,
    FIELD_TYPE_DATETIME, FIELD_TYPE_YEAR,
    FIELD_TYPE_NEWDATE,
    FIELD_TYPE_ENUM = 247,
    FIELD_TYPE_SET = 248,
    FIELD_TYPE_TINY_BLOB = 249,
    FIELD_TYPE_MEDIUM_BLOB = 250,
    FIELD_TYPE_LONG_BLOB = 251,
    FIELD_TYPE_BLOB = 252,
    FIELD_TYPE_VAR_STRING = 253,
    FIELD_TYPE_STRING = 254
};

#define FIELD_TYPE_CHAR FIELD_TYPE_TINY
#define FIELD_TYPE_INTERVAL FIELD_TYPE_ENUM

#define NOT_NULL_FLAG 1
#define PRI_KEY_FLAG 2
#define UNIQUE_KEY_FLAG 4
#define MULTIPLE_KEY_FLAG 8
#define BLOB_FLAG 16
#define UNSIGNED_FLAG 32
#define ZEROFILL_FLAG 64
#define BINARY_FLAG 128
#define ENUM_FLAG 256
#define AUTO_INCREMENT_FLAG 512
#define TIMESTAMP_FLAG 1024
#define SET_FLAG 2048
#define NUM_FLAG 32768

#define IS_PRI_KEY(n) ((n) & PRI_KEY_FLAG)
#define IS_NOT_NULL(n) ((n) & NOT_NULL_FLAG)
#define IS_BLOB(n) ((n) & BLOB_FLAG)
#define IS_NUM(t) ((t) <= FIELD_TYPE_INT24 || (t) == FIELD_TYPE_YEAR)

#define CLIENT_LONG_PASSWORD 1
#define CLIENT_FOUND_ROWS 2
#define CLIENT_LONG_FLAG 4
#define CLIENT_CONNECT_WITH_DB 8
#define CLIENT_NO_SCHEMA 16
#define CLIENT_COMPRESS 32
#define CLIENT_ODBC 64
#define CLIENT_LOCAL_FILES 128
#define CLIENT_IGNORE_SPACE 256
#define CLIENT_CHANGE_USER 512
#define CLIENT_INTERACTIVE 1024
#define CLIENT_SSL 2048
#define CLIENT_IGNORE_SIGPIPE 4096
#define CLIENT_TRANSACTIONS 8192

enum mysql_option {
    MYSQL_OPT_CONNECT_TIMEOUT, MYSQL_OPT_COMPRESS,
    MYSQL_OPT_NAMED_PIPE, MYSQL_INIT_COMMAND,
    MYSQL_READ_DEFAULT_FILE, MYSQL_READ_DEFAULT_GROUP,
    MYSQL_SET_CHARSET_DIR, MYSQL_SET_CHARSET_NAME,
    MYSQL_OPT_LOCAL_INFILE
};

typedef struct st_mysql_field {
    char *name;
    char *table;
    char *def;
    enum enum_field_types type;
    unsigned int length;
    unsigned int max_length;
    unsigned int flags;
    unsigned int decimals;
} MYSQL_FIELD;

typedef struct st_mysql_res {
    my_ulonglong row_count;
    unsigned int field_count;
    MYSQL_FIELD *fields;
    MYSQL_ROW *rows;
    unsigned long **lengths;
    my_ulonglong next_row;
    MYSQL_ROW current_row;
    unsigned long *current_lengths;
    MYSQL_FIELD_OFFSET current_field;
    my_bool eof;
    char *response;
    char **cells;
    unsigned long *cell_lengths;
} MYSQL_RES;

typedef struct st_mysql {
    unsigned int link;
    unsigned int last_errno;
    char last_error[512];
    my_ulonglong affected_rows;
    my_ulonglong insert_id;
    unsigned int field_count;
    MYSQL_RES *pending_result;
    char server_version[32];
    char host_info[128];
    my_bool free_me;
} MYSQL;

/* Functions, not macros, as in 3.23.49: config.m4 link-tests mysql_close,
   mysql_error and mysql_errno against the library. */
my_ulonglong mysql_num_rows(MYSQL_RES *res);
unsigned int mysql_num_fields(MYSQL_RES *res);
my_bool mysql_eof(MYSQL_RES *res);
unsigned int mysql_field_count(MYSQL *mysql);
my_ulonglong mysql_affected_rows(MYSQL *mysql);
my_ulonglong mysql_insert_id(MYSQL *mysql);
unsigned int mysql_errno(MYSQL *mysql);
char *mysql_error(MYSQL *mysql);
unsigned long mysql_thread_id(MYSQL *mysql);

MYSQL *mysql_init(MYSQL *mysql);
int mysql_options(MYSQL *mysql, enum mysql_option option, const char *arg);
MYSQL *mysql_real_connect(MYSQL *mysql, const char *host, const char *user,
    const char *passwd, const char *db, unsigned int port,
    const char *unix_socket, unsigned int client_flag);
MYSQL *mysql_connect(MYSQL *mysql, const char *host, const char *user, const char *passwd);
void mysql_close(MYSQL *mysql);
int mysql_select_db(MYSQL *mysql, const char *db);
int mysql_query(MYSQL *mysql, const char *q);
int mysql_real_query(MYSQL *mysql, const char *q, unsigned long length);
MYSQL_RES *mysql_store_result(MYSQL *mysql);
MYSQL_RES *mysql_use_result(MYSQL *mysql);
void mysql_free_result(MYSQL_RES *result);
MYSQL_ROW mysql_fetch_row(MYSQL_RES *result);
unsigned long *mysql_fetch_lengths(MYSQL_RES *result);
MYSQL_FIELD *mysql_fetch_field(MYSQL_RES *result);
MYSQL_FIELD_OFFSET mysql_field_seek(MYSQL_RES *result, MYSQL_FIELD_OFFSET offset);
void mysql_data_seek(MYSQL_RES *result, my_ulonglong offset);
MYSQL_RES *mysql_list_dbs(MYSQL *mysql, const char *wild);
MYSQL_RES *mysql_list_tables(MYSQL *mysql, const char *wild);
MYSQL_RES *mysql_list_fields(MYSQL *mysql, const char *table, const char *wild);
MYSQL_RES *mysql_list_processes(MYSQL *mysql);
int mysql_create_db(MYSQL *mysql, const char *db);
int mysql_drop_db(MYSQL *mysql, const char *db);
char *mysql_get_client_info(void);
char *mysql_get_server_info(MYSQL *mysql);
char *mysql_get_host_info(MYSQL *mysql);
unsigned int mysql_get_proto_info(MYSQL *mysql);
char *mysql_stat(MYSQL *mysql);
int mysql_ping(MYSQL *mysql);
char *mysql_info(MYSQL *mysql);
const char *mysql_character_set_name(MYSQL *mysql);
unsigned long mysql_escape_string(char *to, const char *from, unsigned long from_length);
unsigned long mysql_real_escape_string(MYSQL *mysql, char *to, const char *from, unsigned long length);
my_bool mysql_thread_init(void);
void mysql_thread_end(void);

#endif
