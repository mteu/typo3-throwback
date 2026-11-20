/*
 * A request-loop SAPI for PHP 5.6.40 under Emscripten. It has the entry
 * points and the request block of php-4.4.9/sapi.c, so runtime/php-runtime.js
 * drives either interpreter the same way. One entry point is its own:
 * php_wasm_set_argv(), a command line for a script written for the CLI.
 *
 * Modelled on the FastCGI loop in sapi/cgi/cgi_main.c: php_module_startup()
 * once, then php_request_startup(), php_execute_script() and
 * php_request_shutdown() per request, in the same process. JS calls
 * php_wasm_startup() once and php_wasm_request() per request.
 *
 * A request is described the way a CGI server describes one: a block of
 * NAME=VALUE pairs, each terminated by a NUL byte, plus the request body.
 * Those pairs are $_SERVER, $_ENV and what getenv() sees, as they are under
 * a CGI SAPI.
 *
 * Output, headers and log lines leave as raw bytes, whatever the character
 * set, so nothing here decodes them.
 */

#include "php.h"
#include "php_main.h"
#include "php_variables.h"
#include "SAPI.h"
#include "fopen_wrappers.h"

#include <emscripten.h>

/* Each drops what arrives while no request is collecting: output can only
   come from outside a request if something already went wrong, such as an
   execution timer firing after a request ended in a trap. */
EM_JS(void, php_js_write, (const char *data, unsigned int length), {
    if (Module.phpResponse) {
        Module.phpResponse.body.push(HEAPU8.slice(data, data + length));
    }
});

EM_JS(void, php_js_status, (int code), {
    if (Module.phpResponse) {
        Module.phpResponse.status = code;
    }
});

EM_JS(void, php_js_header, (const char *line, unsigned int length), {
    if (Module.phpResponse) {
        Module.phpResponse.headers.push(HEAPU8.slice(line, line + length));
    }
});

EM_JS(void, php_js_log, (const char *message, unsigned int length), {
    if (Module.phpResponse) {
        Module.phpResponse.log.push(HEAPU8.slice(message, message + length));
    }
});

static const char *request_env = NULL;
static unsigned int request_env_length = 0;
static const char *request_body = NULL;
static unsigned int request_body_length = 0;
static unsigned int request_body_read = 0;

/* The command line of the next request, as the CLI would give its script:
   the script's path, then its arguments. Set by php_wasm_set_argv(), used by
   one request and dropped after it. */
static int request_argc = 0;
static char **request_argv = NULL;

static void drop_request_argv(void)
{
    int i;

    for (i = 0; i < request_argc; i++) {
        free(request_argv[i]);
    }
    free(request_argv);
    request_argc = 0;
    request_argv = NULL;
}

static char *find_request_env(const char *name, size_t name_length)
{
    const char *entry = request_env;
    const char *end = request_env + request_env_length;

    if (request_env == NULL) {
        return NULL;
    }
    while (entry < end && *entry) {
        size_t entry_length = strlen(entry);
        if (entry_length > name_length && entry[name_length] == '='
                && strncmp(entry, name, name_length) == 0) {
            return (char *) entry + name_length + 1;
        }
        entry += entry_length + 1;
    }
    return NULL;
}

static void register_request_env(zval *track_vars_array TSRMLS_DC)
{
    const char *entry = request_env;
    const char *end = request_env + request_env_length;
    char name[256];

    if (request_env == NULL) {
        return;
    }
    while (entry < end && *entry) {
        size_t entry_length = strlen(entry);
        const char *separator = strchr(entry, '=');
        if (separator != NULL && (size_t) (separator - entry) < sizeof(name)) {
            memcpy(name, entry, separator - entry);
            name[separator - entry] = '\0';
            php_register_variable_safe(name, (char *) separator + 1,
                strlen(separator + 1), track_vars_array TSRMLS_CC);
        }
        entry += entry_length + 1;
    }
}

static int wasm_ub_write(const char *str, unsigned int str_length TSRMLS_DC)
{
    php_js_write(str, str_length);
    return str_length;
}

static void wasm_flush(void *server_context)
{
}

static char *wasm_getenv(char *name, size_t name_len TSRMLS_DC)
{
    return find_request_env(name, name_len);
}

static int wasm_send_headers(sapi_headers_struct *sapi_headers TSRMLS_DC)
{
    sapi_header_struct *header;
    zend_llist_position position;

    php_js_status(SG(sapi_headers).http_response_code);
    header = zend_llist_get_first_ex(&sapi_headers->headers, &position);
    while (header) {
        if (header->header_len) {
            php_js_header(header->header, header->header_len);
        }
        header = zend_llist_get_next_ex(&sapi_headers->headers, &position);
    }
    return SAPI_HEADER_SENT_SUCCESSFULLY;
}

/* PHP 5.6 copies the body into SG(request_info).request_body, which
   php://input reads, through this, whatever the content type. */
static int wasm_read_post(char *buffer, uint count_bytes TSRMLS_DC)
{
    unsigned int remaining = request_body_length - request_body_read;

    if (count_bytes > remaining) {
        count_bytes = remaining;
    }
    memcpy(buffer, request_body + request_body_read, count_bytes);
    request_body_read += count_bytes;
    return count_bytes;
}

static char *wasm_read_cookies(TSRMLS_D)
{
    return find_request_env("HTTP_COOKIE", sizeof("HTTP_COOKIE") - 1);
}

static void wasm_register_variables(zval *track_vars_array TSRMLS_DC)
{
    register_request_env(track_vars_array TSRMLS_CC);
    php_register_variable("PHP_SELF",
        SG(request_info).request_uri ? SG(request_info).request_uri : "",
        track_vars_array TSRMLS_CC);
}

static void wasm_log_message(char *message TSRMLS_DC)
{
    php_js_log(message, strlen(message));
}

static int wasm_startup(sapi_module_struct *module)
{
    return php_module_startup(module, NULL, 0);
}

static sapi_module_struct wasm_sapi_module = {
    "wasm",                         /* name */
    "WebAssembly request loop",     /* pretty name */

    wasm_startup,                   /* startup */
    php_module_shutdown_wrapper,    /* shutdown */

    NULL,                           /* activate */
    NULL,                           /* deactivate */

    wasm_ub_write,                  /* unbuffered write */
    wasm_flush,                     /* flush */
    NULL,                           /* get uid */
    wasm_getenv,                    /* getenv */

    php_error,                      /* error handler */

    NULL,                           /* header handler */
    wasm_send_headers,              /* send headers handler */
    NULL,                           /* send header handler */

    wasm_read_post,                 /* read POST data */
    wasm_read_cookies,              /* read cookies */

    wasm_register_variables,        /* register server variables */
    wasm_log_message,               /* log message */
    NULL,                           /* request time: gettimeofday(), the clock in native/clock.c */
    NULL,                           /* terminate process */

    NULL,                           /* php.ini path override, set at startup */
    NULL,                           /* block interruptions */
    NULL,                           /* unblock interruptions */
    NULL,                           /* default post reader */
    NULL,                           /* treat data */
    NULL,                           /* executable location */

    0,                              /* php.ini ignore */
    1,                              /* php.ini ignore cwd: only the path given at startup */

    NULL,                           /* get fd */
    NULL,                           /* force HTTP/1.0 */

    STANDARD_SAPI_MODULE_PROPERTIES
};

/*
 * ini_search_path is where PHP looks for php.ini, as php_ini.c reads
 * php_ini_path_override: a directory list, not a file name.
 * Returns 0 on success.
 */
EMSCRIPTEN_KEEPALIVE int php_wasm_startup(const char *ini_search_path)
{
    sapi_startup(&wasm_sapi_module);
    wasm_sapi_module.php_ini_path_override = strdup(ini_search_path);

    /* OpenSSL's configuration, where openssl_pkey_new() reads its key size,
       lives beside php.ini: runtime/php-runtime.js writes both. ext/openssl
       reads OPENSSL_CONF once, at module startup. */
    {
        char *openssl_conf = malloc(strlen(ini_search_path) + sizeof("/openssl.cnf"));
        if (openssl_conf == NULL) {
            return 1;
        }
        strcpy(openssl_conf, ini_search_path);
        strcat(openssl_conf, "/openssl.cnf");
        setenv("OPENSSL_CONF", openssl_conf, 1);
        free(openssl_conf);
    }

    /* A CGI SAPI fills $_ENV from the process environment, which a CGI
       server sets to the request. Here the request block plays that part,
       so $_ENV matches what a server would give, and Emscripten's made-up
       process environment stays out. */
    php_import_environment_variables = register_request_env;

    if (wasm_sapi_module.startup(&wasm_sapi_module) == FAILURE) {
        return 1;
    }
    return 0;
}

/*
 * Gives the next request a command line: args are its arguments, each
 * NUL-terminated, args_length bytes in total, the script's path first.
 * PHP sets the globals $argv and $argc only when the SAPI has a command line
 * (main/php_variables.c:555-610), which a web request does not. A script
 * written for the CLI, such as 6.2/provision.php, reads its mode from
 * $argv[1]. Returns 0 on success.
 */
EMSCRIPTEN_KEEPALIVE int php_wasm_set_argv(const char *args, unsigned int args_length)
{
    const char *arg = args;
    const char *end = args + args_length;
    int count = 0;
    int i;

    drop_request_argv();
    while (arg < end) {
        arg += strlen(arg) + 1;
        count++;
    }
    request_argv = calloc(count + 1, sizeof(char *));
    if (request_argv == NULL) {
        return 1;
    }
    arg = args;
    for (i = 0; i < count; i++) {
        request_argv[i] = strdup(arg);
        if (request_argv[i] == NULL) {
            request_argc = i;
            drop_request_argv();
            return 1;
        }
        arg += strlen(arg) + 1;
    }
    request_argc = count;
    return 0;
}

/*
 * env: NAME=VALUE pairs, each NUL-terminated, env_length bytes in total.
 * Returns 0 when the request ran, whatever the script did; 1 when PHP could
 * not start the request at all.
 */
EMSCRIPTEN_KEEPALIVE int php_wasm_request(const char *env, unsigned int env_length,
    const char *body, unsigned int body_length)
{
    zend_file_handle file_handle;
    char *content_length;
    char *content_type;
    char *script_filename;
    int result = 0;
    TSRMLS_FETCH();

    request_env = env;
    request_env_length = env_length;
    request_body = body;
    request_body_length = body_length;
    request_body_read = 0;

    SG(server_context) = (void *) 1;
    SG(request_info).request_method = find_request_env("REQUEST_METHOD", sizeof("REQUEST_METHOD") - 1);
    SG(request_info).query_string = find_request_env("QUERY_STRING", sizeof("QUERY_STRING") - 1);
    SG(request_info).request_uri = find_request_env("SCRIPT_NAME", sizeof("SCRIPT_NAME") - 1);
    /* php_fopen_primary_script() efree()s this on failure
       (main/fopen_wrappers.c:442), so it must come from the request's memory
       manager, as in the CGI SAPI. */
    script_filename = find_request_env("SCRIPT_FILENAME", sizeof("SCRIPT_FILENAME") - 1);
    SG(request_info).path_translated = script_filename ? estrdup(script_filename) : NULL;
    content_type = find_request_env("CONTENT_TYPE", sizeof("CONTENT_TYPE") - 1);
    SG(request_info).content_type = content_type ? content_type : "";
    content_length = find_request_env("CONTENT_LENGTH", sizeof("CONTENT_LENGTH") - 1);
    SG(request_info).content_length = content_length ? atol(content_length) : 0;
    SG(request_info).headers_only = 0;
    SG(request_info).no_headers = 0;
    /* sapi_activate() leaves the code alone (its reset to 200 is commented
       out, main/SAPI.c:455), so each SAPI sets it, as
       sapi/apache2handler/sapi_apache2.c does. */
    SG(sapi_headers).http_response_code = 200;
    SG(request_info).argc = request_argc;
    SG(request_info).argv = request_argv;

    zend_first_try {
        if (php_request_startup(TSRMLS_C) == FAILURE) {
            result = 1;
        } else {
            memset(&file_handle, 0, sizeof(file_handle));
            file_handle.type = ZEND_HANDLE_FILENAME;
            file_handle.filename = SG(request_info).path_translated;

            if (file_handle.filename == NULL
                    || php_fopen_primary_script(&file_handle TSRMLS_CC) == FAILURE) {
                SG(sapi_headers).http_response_code = 404;
                PUTS("No input file specified.\n");
            } else {
                php_execute_script(&file_handle TSRMLS_CC);
            }
        }
    } zend_end_try();

    /* Moved out of the request's memory manager before it shuts down, and
       freed after, as sapi/cgi/cgi_main.c does. */
    if (SG(request_info).path_translated) {
        char *persistent_copy = strdup(SG(request_info).path_translated);
        STR_FREE(SG(request_info).path_translated);
        SG(request_info).path_translated = persistent_copy;
    }

    /* Always, even after a failed startup, as the Apache SAPI does through
       its pool cleanup. Inside a try of its own: a bailout with no try around
       it calls exit() (Zend/zend.c:890) and would end the instance, not just
       the request. */
    zend_try {
        php_request_shutdown((void *) 0);
    } zend_end_try();

    if (SG(request_info).path_translated) {
        free(SG(request_info).path_translated);
    }

    SG(server_context) = NULL;
    SG(request_info).request_method = NULL;
    SG(request_info).query_string = NULL;
    SG(request_info).request_uri = NULL;
    SG(request_info).path_translated = NULL;
    SG(request_info).content_type = NULL;
    SG(request_info).argc = 0;
    SG(request_info).argv = NULL;
    drop_request_argv();
    request_env = NULL;
    request_env_length = 0;
    request_body = NULL;
    request_body_length = 0;
    return result;
}
