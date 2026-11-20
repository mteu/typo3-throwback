/*
 * popen() for PHP 4.4.9 and PHP 5.6.40 under Emscripten, which cannot start
 * a process at all. Its popen() and pclose() are weak stubs that fail with
 * ENOSYS (system/lib/libc/emscripten_libc_stubs.c). These replace them for
 * the two commands a shell would finish without running anything here:
 *
 * /bin/true alone, with any arguments. Every Docker stack here sets
 * sendmail_path = /bin/true, so PHP's mail() pipes each message into a
 * program that reads nothing and exits 0: mail() returns true and nothing is
 * sent. With the stubs, mail() warned "Could not execute mail delivery
 * program" and returned false. mail() appends its fifth argument to the
 * command, through php_escape_shell_cmd(), so a backslash escapes the next
 * character.
 *
 * A program given as an absolute path, bare or in single quotes as
 * escapeshellarg() writes it, that names no file in PHP's filesystem. sh
 * says it is not found, on stderr, and exits 127; PHP's exec() returns no
 * output and that status, without a warning. TYPO3 6.2's Install Tool asks
 * '/usr/bin/identify' -version on every page of its image tests, whether
 * ImageMagick is enabled or not, and 6.2's Docker image has none.
 *
 * Either gets a stream on /dev/null, and pclose() reports the exit status.
 * Any other command fails with ENOSYS, as before. A command with shell
 * syntax beyond plain words, such as a pipe, a list or a substitution,
 * counts as any other.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define MAX_OPEN 16
#define MAX_PROGRAM 1024
#define NOT_RUN -1

static FILE *open_streams[MAX_OPEN];
static int exit_statuses[MAX_OPEN];

/* Copies the command's first word into program, without its single quotes,
   and returns 1 if the rest is plain words: no shell syntax but a
   backslash escaping the next character. */
static int read_plain_command(const char *command, char *program) {
    const char *p = command;
    size_t length = 0;

    while (*p == ' ' || *p == '\t') {
        p++;
    }
    if (*p == '\'') {
        for (p++; *p != '\'' && *p != '\0'; p++) {
            if (length == MAX_PROGRAM - 1) {
                return 0;
            }
            program[length++] = *p;
        }
        if (*p++ != '\'') {
            return 0;
        }
    } else {
        for (; *p != '\0' && *p != ' ' && *p != '\t'; p++) {
            if (length == MAX_PROGRAM - 1 || strchr("\\'\";&|`$()<>\n", *p) != NULL) {
                return 0;
            }
            program[length++] = *p;
        }
    }
    program[length] = '\0';
    if (length == 0 || strchr(program, '\n') != NULL || (*p != '\0' && *p != ' ' && *p != '\t')) {
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

/* The exit status sh would end the command with, as wait() reports it, or
   NOT_RUN if it would have to run a program. */
static int status_without_running(const char *command) {
    char program[MAX_PROGRAM];

    if (!read_plain_command(command, program)) {
        return NOT_RUN;
    }
    if (strcmp(program, "/bin/true") == 0) {
        return 0;
    }
    if (program[0] == '/' && access(program, F_OK) != 0 && errno == ENOENT) {
        return 127 << 8;
    }
    return NOT_RUN;
}

FILE *popen(const char *command, const char *type) {
    FILE *stream;
    int status;
    int i;

    if (command == NULL || type == NULL || (type[0] != 'r' && type[0] != 'w')) {
        errno = ENOSYS;
        return NULL;
    }
    status = status_without_running(command);
    if (status == NOT_RUN) {
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
    exit_statuses[i] = status;
    return stream;
}

int pclose(FILE *stream) {
    int i;

    for (i = 0; i < MAX_OPEN; i++) {
        if (stream != NULL && open_streams[i] == stream) {
            open_streams[i] = NULL;
            fclose(stream);
            return exit_statuses[i];
        }
    }
    errno = ECHILD;
    return -1;
}
