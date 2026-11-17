/*
 * popen() for PHP 4 under Emscripten: the one program the build can run is
 * /bin/true.
 *
 * Every Docker stack here sets sendmail_path = /bin/true, so PHP's mail()
 * pipes each message into a program that reads nothing and exits 0: mail()
 * returns true and nothing is sent. Emscripten cannot start a process at all.
 * Its popen() and pclose() are weak stubs that fail with ENOSYS
 * (system/lib/libc/emscripten_libc_stubs.c), so mail() warned "Could not
 * execute mail delivery program" and returned false.
 *
 * These replace the stubs. A command that the shell would run as /bin/true
 * alone, with any arguments, gets a stream on /dev/null, and pclose() reports
 * exit status 0, as /bin/true does. mail() appends its fifth argument to the
 * command, through php_escape_shell_cmd(), so a backslash escapes the next
 * character. Any other command fails with ENOSYS, as before. exec('/bin/true')
 * now succeeds too, as it does in Docker.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>

#define MAX_OPEN 16

static FILE *open_streams[MAX_OPEN];

static int runs_bin_true_alone(const char *command) {
    static const char program[] = "/bin/true";
    const char *p = command;

    while (*p == ' ' || *p == '\t') {
        p++;
    }
    if (strncmp(p, program, sizeof(program) - 1) != 0) {
        return 0;
    }
    p += sizeof(program) - 1;
    if (*p != '\0' && *p != ' ' && *p != '\t') {
        return 0;
    }
    for (; *p != '\0'; p++) {
        if (*p == '\\') {
            if (*++p == '\0') {
                return 0;
            }
        } else if (strchr(";&|`$()<>\n", *p) != NULL) {
            return 0;
        }
    }
    return 1;
}

FILE *popen(const char *command, const char *type) {
    FILE *stream;
    int i;

    if (command == NULL || type == NULL || (type[0] != 'r' && type[0] != 'w') || !runs_bin_true_alone(command)) {
        errno = ENOSYS;
        return NULL;
    }
    for (i = 0; i < MAX_OPEN && open_streams[i] != NULL; i++) {
    }
    if (i == MAX_OPEN) {
        errno = EMFILE;
        return NULL;
    }
    stream = fopen("/dev/null", type[0] == 'r' ? "r" : "w");
    if (stream == NULL) {
        return NULL;
    }
    open_streams[i] = stream;
    return stream;
}

int pclose(FILE *stream) {
    int i;

    for (i = 0; i < MAX_OPEN; i++) {
        if (stream != NULL && open_streams[i] == stream) {
            open_streams[i] = NULL;
            fclose(stream);
            return 0;
        }
    }
    errno = ECHILD;
    return -1;
}
