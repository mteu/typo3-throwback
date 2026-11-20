/*
 * A MySQL client API answered by runtime/mysql-sqlite.js instead of a server,
 * in one of two versions, chosen when the library is built:
 *
 *   3.23.49, the client PHP 4.4.9 bundles, for PHP 4's ext/mysql;
 *   5.5.62, when WASM_LIBMYSQL_API_55 is defined, for PHP 5.6's ext/mysql
 *   and mysqli, prepared statements included.
 *
 * Each version declares what PHP's extensions compile against. Names, type
 * codes, flags and the MYSQL_FIELD and MYSQL_BIND layouts follow the real
 * client of that version. MYSQL, MYSQL_RES and MYSQL_STMT are this library's
 * own: they carry, by name, the members of the real structs that mysqli reads
 * and writes directly, and their own members after those.
 */

#ifndef WASM_LIBMYSQL_MYSQL_H
#define WASM_LIBMYSQL_MYSQL_H

#ifdef WASM_LIBMYSQL_API_55
#define MYSQL_SERVER_VERSION "5.5.62"
#define MYSQL_VERSION_ID 50562
#else
#define MYSQL_SERVER_VERSION "3.23.49"
#define MYSQL_VERSION_ID 32349
#endif
#define PROTOCOL_VERSION 10
#define MYSQL_PORT 3306
#define MYSQL_UNIX_ADDR "/tmp/mysql.sock"
#define MYSQL_ERRMSG_SIZE 512
#define SQLSTATE_LENGTH 5
#define NAME_LEN 64

typedef char my_bool;
typedef unsigned long long my_ulonglong;
typedef char **MYSQL_ROW;
typedef unsigned int MYSQL_FIELD_OFFSET;

#ifdef WASM_LIBMYSQL_API_55

enum enum_field_types {
    MYSQL_TYPE_DECIMAL, MYSQL_TYPE_TINY,
    MYSQL_TYPE_SHORT, MYSQL_TYPE_LONG,
    MYSQL_TYPE_FLOAT, MYSQL_TYPE_DOUBLE,
    MYSQL_TYPE_NULL, MYSQL_TYPE_TIMESTAMP,
    MYSQL_TYPE_LONGLONG, MYSQL_TYPE_INT24,
    MYSQL_TYPE_DATE, MYSQL_TYPE_TIME,
    MYSQL_TYPE_DATETIME, MYSQL_TYPE_YEAR,
    MYSQL_TYPE_NEWDATE, MYSQL_TYPE_VARCHAR,
    MYSQL_TYPE_BIT,
    MYSQL_TYPE_NEWDECIMAL = 246,
    MYSQL_TYPE_ENUM = 247,
    MYSQL_TYPE_SET = 248,
    MYSQL_TYPE_TINY_BLOB = 249,
    MYSQL_TYPE_MEDIUM_BLOB = 250,
    MYSQL_TYPE_LONG_BLOB = 251,
    MYSQL_TYPE_BLOB = 252,
    MYSQL_TYPE_VAR_STRING = 253,
    MYSQL_TYPE_STRING = 254,
    MYSQL_TYPE_GEOMETRY = 255
};

#define FIELD_TYPE_DECIMAL MYSQL_TYPE_DECIMAL
#define FIELD_TYPE_NEWDECIMAL MYSQL_TYPE_NEWDECIMAL
#define FIELD_TYPE_TINY MYSQL_TYPE_TINY
#define FIELD_TYPE_SHORT MYSQL_TYPE_SHORT
#define FIELD_TYPE_LONG MYSQL_TYPE_LONG
#define FIELD_TYPE_FLOAT MYSQL_TYPE_FLOAT
#define FIELD_TYPE_DOUBLE MYSQL_TYPE_DOUBLE
#define FIELD_TYPE_NULL MYSQL_TYPE_NULL
#define FIELD_TYPE_TIMESTAMP MYSQL_TYPE_TIMESTAMP
#define FIELD_TYPE_LONGLONG MYSQL_TYPE_LONGLONG
#define FIELD_TYPE_INT24 MYSQL_TYPE_INT24
#define FIELD_TYPE_DATE MYSQL_TYPE_DATE
#define FIELD_TYPE_TIME MYSQL_TYPE_TIME
#define FIELD_TYPE_DATETIME MYSQL_TYPE_DATETIME
#define FIELD_TYPE_YEAR MYSQL_TYPE_YEAR
#define FIELD_TYPE_NEWDATE MYSQL_TYPE_NEWDATE
#define FIELD_TYPE_ENUM MYSQL_TYPE_ENUM
#define FIELD_TYPE_SET MYSQL_TYPE_SET
#define FIELD_TYPE_TINY_BLOB MYSQL_TYPE_TINY_BLOB
#define FIELD_TYPE_MEDIUM_BLOB MYSQL_TYPE_MEDIUM_BLOB
#define FIELD_TYPE_LONG_BLOB MYSQL_TYPE_LONG_BLOB
#define FIELD_TYPE_BLOB MYSQL_TYPE_BLOB
#define FIELD_TYPE_VAR_STRING MYSQL_TYPE_VAR_STRING
#define FIELD_TYPE_STRING MYSQL_TYPE_STRING
#define FIELD_TYPE_CHAR MYSQL_TYPE_TINY
#define FIELD_TYPE_INTERVAL MYSQL_TYPE_ENUM
#define FIELD_TYPE_GEOMETRY MYSQL_TYPE_GEOMETRY
#define FIELD_TYPE_BIT MYSQL_TYPE_BIT

#else

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

#endif

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
#ifdef WASM_LIBMYSQL_API_55
#define NO_DEFAULT_VALUE_FLAG 4096
#define ON_UPDATE_NOW_FLAG 8192
#define PART_KEY_FLAG 16384
#define GROUP_FLAG 32768
#define UNIQUE_FLAG 65536
#define BINCMP_FLAG 131072
#endif

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
#define CLIENT_INTERACTIVE 1024
#define CLIENT_SSL 2048
#define CLIENT_IGNORE_SIGPIPE 4096
#define CLIENT_TRANSACTIONS 8192
#ifdef WASM_LIBMYSQL_API_55
#define CLIENT_PROTOCOL_41 512
#define CLIENT_RESERVED 16384
#define CLIENT_SECURE_CONNECTION 32768
#define CLIENT_MULTI_STATEMENTS (1UL << 16)
#define CLIENT_MULTI_RESULTS (1UL << 17)
#define CLIENT_PS_MULTI_RESULTS (1UL << 18)
#define CLIENT_PLUGIN_AUTH (1UL << 19)
#define CLIENT_SSL_VERIFY_SERVER_CERT (1UL << 30)
#define CLIENT_REMEMBER_OPTIONS (1UL << 31)
#else
#define CLIENT_CHANGE_USER 512
#endif

#ifdef WASM_LIBMYSQL_API_55
#define SERVER_STATUS_IN_TRANS 1
#define SERVER_STATUS_AUTOCOMMIT 2
#define SERVER_MORE_RESULTS_EXISTS 8
#define SERVER_QUERY_NO_GOOD_INDEX_USED 16
#define SERVER_QUERY_NO_INDEX_USED 32
#define SERVER_STATUS_CURSOR_EXISTS 64
#define SERVER_STATUS_LAST_ROW_SENT 128
#define SERVER_STATUS_DB_DROPPED 256
#define SERVER_STATUS_NO_BACKSLASH_ESCAPES 512
#define SERVER_STATUS_METADATA_CHANGED 1024
#define SERVER_QUERY_WAS_SLOW 2048
#define SERVER_PS_OUT_PARAMS 4096

#define REFRESH_GRANT 1
#define REFRESH_LOG 2
#define REFRESH_TABLES 4
#define REFRESH_HOSTS 8
#define REFRESH_STATUS 16
#define REFRESH_THREADS 32
#define REFRESH_SLAVE 64
#define REFRESH_MASTER 128

#define NOT_FIXED_DEC 31

/* mysql_stmt_fetch()'s answers besides 0 and 1. */
#define MYSQL_NO_DATA 100
#define MYSQL_DATA_TRUNCATED 101
#endif

enum mysql_option {
    MYSQL_OPT_CONNECT_TIMEOUT, MYSQL_OPT_COMPRESS,
    MYSQL_OPT_NAMED_PIPE, MYSQL_INIT_COMMAND,
    MYSQL_READ_DEFAULT_FILE, MYSQL_READ_DEFAULT_GROUP,
    MYSQL_SET_CHARSET_DIR, MYSQL_SET_CHARSET_NAME,
    MYSQL_OPT_LOCAL_INFILE
#ifdef WASM_LIBMYSQL_API_55
    , MYSQL_OPT_PROTOCOL, MYSQL_SHARED_MEMORY_BASE_NAME,
    MYSQL_OPT_READ_TIMEOUT, MYSQL_OPT_WRITE_TIMEOUT,
    MYSQL_OPT_USE_RESULT, MYSQL_OPT_USE_REMOTE_CONNECTION,
    MYSQL_OPT_USE_EMBEDDED_CONNECTION, MYSQL_OPT_GUESS_CONNECTION,
    MYSQL_SET_CLIENT_IP, MYSQL_SECURE_AUTH,
    MYSQL_REPORT_DATA_TRUNCATION, MYSQL_OPT_RECONNECT,
    MYSQL_OPT_SSL_VERIFY_SERVER_CERT, MYSQL_PLUGIN_DIR,
    MYSQL_DEFAULT_AUTH, MYSQL_ENABLE_CLEARTEXT_PLUGIN
#endif
};

enum mysql_status {
    MYSQL_STATUS_READY, MYSQL_STATUS_GET_RESULT, MYSQL_STATUS_USE_RESULT
};

#ifdef WASM_LIBMYSQL_API_55
enum enum_mysql_set_option {
    MYSQL_OPTION_MULTI_STATEMENTS_ON, MYSQL_OPTION_MULTI_STATEMENTS_OFF
};

enum enum_stmt_attr_type {
    STMT_ATTR_UPDATE_MAX_LENGTH, STMT_ATTR_CURSOR_TYPE, STMT_ATTR_PREFETCH_ROWS
};

enum enum_cursor_type {
    CURSOR_TYPE_NO_CURSOR = 0, CURSOR_TYPE_READ_ONLY = 1,
    CURSOR_TYPE_FOR_UPDATE = 2, CURSOR_TYPE_SCROLLABLE = 4
};

/* Of a real client's charset_info_st, mysqli reads only csname. */
typedef struct charset_info_st {
    unsigned int number;
    const char *csname;
    const char *name;
} CHARSET_INFO;

typedef struct character_set {
    unsigned int number;
    unsigned int state;
    const char *csname;
    const char *name;
    const char *comment;
    const char *dir;
    unsigned int mbminlen;
    unsigned int mbmaxlen;
} MY_CHARSET_INFO;

typedef struct st_mysql_field {
    char *name;
    char *org_name;
    char *table;
    char *org_table;
    char *db;
    char *catalog;
    char *def;
    unsigned long length;
    unsigned long max_length;
    unsigned int name_length;
    unsigned int org_name_length;
    unsigned int table_length;
    unsigned int org_table_length;
    unsigned int db_length;
    unsigned int catalog_length;
    unsigned int def_length;
    unsigned int flags;
    unsigned int decimals;
    unsigned int charsetnr;
    enum enum_field_types type;
    void *extension;
} MYSQL_FIELD;
#else
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
#endif

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
    char *db;
    /* Every result here is buffered: mysqli takes one for an unbuffered
       MYSQL_USE_RESULT only with a handle and no data. */
    struct st_mysql *handle;
    void *data;
} MYSQL_RES;

typedef struct st_net {
    unsigned int last_errno;
    char last_error[MYSQL_ERRMSG_SIZE];
    char sqlstate[SQLSTATE_LENGTH + 1];
} NET;

#define WASM_LIBMYSQL_INIT_COMMANDS 8

typedef struct st_mysql {
    NET net;
    char *host_info;
    struct charset_info_st *charset;
    unsigned int server_status;
    enum mysql_status status;
    my_bool reconnect;

    unsigned int link;
    my_ulonglong affected_rows;
    my_ulonglong insert_id;
    unsigned int field_count;
    MYSQL_RES *pending_result;
    char server_version[32];
    char host_info_buffer[128];
    char host[NAME_LEN + 1];
    char db[NAME_LEN + 1];
    char charset_name[32];
    char *option_charset;
    char *init_commands[WASM_LIBMYSQL_INIT_COMMANDS];
    unsigned int init_command_count;
    my_bool free_me;
} MYSQL;

#ifdef WASM_LIBMYSQL_API_55
typedef struct st_mysql_bind {
    unsigned long *length;
    my_bool *is_null;
    void *buffer;
    my_bool *error;
    unsigned char *row_ptr;
    void (*store_param_func)(NET *net, struct st_mysql_bind *param);
    void (*fetch_result)(struct st_mysql_bind *, MYSQL_FIELD *, unsigned char **row);
    void (*skip_result)(struct st_mysql_bind *, MYSQL_FIELD *, unsigned char **row);
    unsigned long buffer_length;
    unsigned long offset;
    unsigned long length_value;
    unsigned int param_number;
    unsigned int pack_length;
    enum enum_field_types buffer_type;
    my_bool error_value;
    my_bool is_unsigned;
    my_bool long_data_used;
    my_bool is_null_value;
    void *extension;
} MYSQL_BIND;

typedef struct st_mysql_stmt {
    MYSQL *mysql;
    MYSQL_BIND *params;
    MYSQL_BIND *bind;
    MYSQL_FIELD *fields;
    unsigned int last_errno;
    char last_error[MYSQL_ERRMSG_SIZE];
    char sqlstate[SQLSTATE_LENGTH + 1];
    unsigned long stmt_id;

    char *query;
    unsigned long *placeholders;
    unsigned int param_count;
    unsigned int field_count;
    char *field_strings;
    MYSQL_RES *result;
    my_ulonglong current_row;
    my_ulonglong affected_rows;
    my_ulonglong insert_id;
    char **long_data;
    unsigned long *long_data_length;
    my_bool update_max_length;
    unsigned long cursor_type;
    unsigned long prefetch_rows;
} MYSQL_STMT;
#endif

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
int mysql_options(MYSQL *mysql, enum mysql_option option, const void *arg);
MYSQL *mysql_real_connect(MYSQL *mysql, const char *host, const char *user,
    const char *passwd, const char *db, unsigned int port,
    const char *unix_socket, unsigned long client_flag);
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
char *mysql_get_client_info(void);
unsigned long mysql_get_client_version(void);
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

#ifdef WASM_LIBMYSQL_API_55
MYSQL_FIELD *mysql_fetch_field_direct(MYSQL_RES *res, unsigned int fieldnr);
MYSQL_FIELD *mysql_fetch_fields(MYSQL_RES *res);
MYSQL_FIELD_OFFSET mysql_field_tell(MYSQL_RES *res);
const char *mysql_sqlstate(MYSQL *mysql);
unsigned int mysql_warning_count(MYSQL *mysql);
unsigned long mysql_get_server_version(MYSQL *mysql);
int mysql_set_character_set(MYSQL *mysql, const char *csname);
void mysql_get_character_set_info(MYSQL *mysql, MY_CHARSET_INFO *charset);
int mysql_set_server_option(MYSQL *mysql, enum enum_mysql_set_option option);
my_bool mysql_change_user(MYSQL *mysql, const char *user, const char *passwd, const char *db);
my_bool mysql_ssl_set(MYSQL *mysql, const char *key, const char *cert,
    const char *ca, const char *capath, const char *cipher);
my_bool mysql_autocommit(MYSQL *mysql, my_bool auto_mode);
my_bool mysql_commit(MYSQL *mysql);
my_bool mysql_rollback(MYSQL *mysql);
my_bool mysql_more_results(MYSQL *mysql);
int mysql_next_result(MYSQL *mysql);
int mysql_refresh(MYSQL *mysql, unsigned int refresh_options);
int mysql_kill(MYSQL *mysql, unsigned long pid);
int mysql_dump_debug_info(MYSQL *mysql);
void mysql_debug(const char *debug);
unsigned int mysql_thread_safe(void);
int mysql_server_init(int argc, char **argv, char **groups);
void mysql_server_end(void);
#define mysql_library_init mysql_server_init
#define mysql_library_end mysql_server_end

MYSQL_STMT *mysql_stmt_init(MYSQL *mysql);
int mysql_stmt_prepare(MYSQL_STMT *stmt, const char *query, unsigned long length);
int mysql_stmt_execute(MYSQL_STMT *stmt);
int mysql_stmt_fetch(MYSQL_STMT *stmt);
int mysql_stmt_store_result(MYSQL_STMT *stmt);
unsigned long mysql_stmt_param_count(MYSQL_STMT *stmt);
my_bool mysql_stmt_attr_set(MYSQL_STMT *stmt, enum enum_stmt_attr_type attr_type, const void *attr);
my_bool mysql_stmt_attr_get(MYSQL_STMT *stmt, enum enum_stmt_attr_type attr_type, void *attr);
my_bool mysql_stmt_bind_param(MYSQL_STMT *stmt, MYSQL_BIND *bnd);
my_bool mysql_stmt_bind_result(MYSQL_STMT *stmt, MYSQL_BIND *bnd);
my_bool mysql_stmt_close(MYSQL_STMT *stmt);
my_bool mysql_stmt_reset(MYSQL_STMT *stmt);
my_bool mysql_stmt_free_result(MYSQL_STMT *stmt);
my_bool mysql_stmt_send_long_data(MYSQL_STMT *stmt, unsigned int param_number,
    const char *data, unsigned long length);
MYSQL_RES *mysql_stmt_result_metadata(MYSQL_STMT *stmt);
unsigned int mysql_stmt_errno(MYSQL_STMT *stmt);
const char *mysql_stmt_error(MYSQL_STMT *stmt);
const char *mysql_stmt_sqlstate(MYSQL_STMT *stmt);
void mysql_stmt_data_seek(MYSQL_STMT *stmt, my_ulonglong offset);
my_ulonglong mysql_stmt_num_rows(MYSQL_STMT *stmt);
my_ulonglong mysql_stmt_affected_rows(MYSQL_STMT *stmt);
my_ulonglong mysql_stmt_insert_id(MYSQL_STMT *stmt);
unsigned int mysql_stmt_field_count(MYSQL_STMT *stmt);
int mysql_stmt_next_result(MYSQL_STMT *stmt);
#else
MYSQL *mysql_connect(MYSQL *mysql, const char *host, const char *user, const char *passwd);
int mysql_create_db(MYSQL *mysql, const char *db);
int mysql_drop_db(MYSQL *mysql, const char *db);
#endif

#endif
