/*
 * getdtablesize() for PHP 5.6 under Emscripten, whose libc does not have it.
 *
 * PHP calls it in one place: php://fd/N refuses an N at or above it
 * (ext/standard/php_fopen_wrapper.c). 1024 is what Linux gives a process by
 * default, as the Docker stacks' PHP sees.
 */
int getdtablesize(void)
{
    return 1024;
}
