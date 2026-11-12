/*
 * Wall clock for PHP 4 under Emscripten: microsecond resolution, and a start
 * time the host can set.
 *
 * Resolution. Emscripten's gettimeofday() has millisecond resolution, so PHP
 * 4's uniqid() (usleep(1) + gettimeofday) repeats within a millisecond.
 * TYPO3 3.x builds session ids from uniqid(), so repeated values mean shared
 * sessions. Sub-millisecond progress comes from performance.now(), and the
 * result is forced strictly increasing, because browsers coarsen
 * performance.now() to 5-100 microseconds.
 *
 * Start time. The Docker stacks start the clock at the release date with
 * libfaketime and let it run. php4_wasm_set_clock_start() does the same here.
 * Without a call the clock reads today, as before.
 *
 * Emscripten's libc reads the wall clock in three places that do not call
 * each other: time() and gettimeofday() (system/lib/libc/emscripten_time.c,
 * both weak) and clock_gettime(), which goes to the WASI clock. PHP's time()
 * and date() use the first, uniqid() and microtime() the second. All three are
 * replaced here, so no reader sees today while another sees 2002.
 *
 * Time zone. Emscripten's localtime() and mktime() take the zone from the
 * JS Date, which is the visitor's. The container runs in UTC, and so does
 * this: the release day's noon reads 12:00 in Berlin and in Tokyo alike. The
 * functions replaced for that are weak in Emscripten's libc too
 * (system/lib/libc/mktime.c and musl/src/time/__tz.c).
 */
#include <sys/time.h>
#include <time.h>
#include <emscripten.h>
#include <emscripten/html5.h>

static double origin_us = -1.0;
static long long last_us = 0;

/*
 * The clock reads start_ms (milliseconds since the epoch, UTC) now, and runs
 * on from there. Call it before module startup.
 */
EMSCRIPTEN_KEEPALIVE
void php4_wasm_set_clock_start(double start_ms)
{
    origin_us = start_ms * 1000.0 - emscripten_get_now() * 1000.0;
    last_us = 0;
}

static long long now_us(void)
{
    long long now;
    if (origin_us < 0.0) {
        origin_us = emscripten_date_now() * 1000.0 - emscripten_get_now() * 1000.0;
    }
    now = (long long)(origin_us + emscripten_get_now() * 1000.0);
    if (now <= last_us) {
        now = last_us + 1;
    }
    last_us = now;
    return now;
}

int gettimeofday(struct timeval *restrict tv, void *restrict tz)
{
    long long now = now_us();
    if (tv) {
        tv->tv_sec = (time_t)(now / 1000000);
        tv->tv_usec = (suseconds_t)(now % 1000000);
    }
    return 0;
}

time_t time(time_t *t)
{
    time_t seconds = (time_t)(now_us() / 1000000);
    if (t) {
        *t = seconds;
    }
    return seconds;
}

/* musl's own, which clock_gettime() is otherwise a weak alias of. */
int __clock_gettime(clockid_t clock, struct timespec *ts);

int clock_gettime(clockid_t clock, struct timespec *ts)
{
    long long now;
    if (clock != CLOCK_REALTIME) {
        return __clock_gettime(clock, ts);
    }
    now = now_us();
    ts->tv_sec = (time_t)(now / 1000000);
    ts->tv_nsec = (long)(now % 1000000) * 1000;
    return 0;
}

void tzset(void)
{
    static char utc[] = "UTC";
    timezone = 0;
    daylight = 0;
    tzname[0] = utc;
    tzname[1] = utc;
}

const char *__tm_to_tzname(const struct tm *tm)
{
    return "UTC";
}

struct tm *__localtime_r(const time_t *restrict t, struct tm *restrict tm)
{
    if (!gmtime_r(t, tm)) {
        return NULL;
    }
    tm->tm_zone = "UTC";
    return tm;
}

struct tm *localtime_r(const time_t *restrict t, struct tm *restrict tm)
{
    return __localtime_r(t, tm);
}

/* As mktime() does, it also normalizes tm: 2002-06-31 becomes 2002-07-01. */
time_t mktime(struct tm *tm)
{
    time_t t = timegm(tm);
    if (t != (time_t)-1) {
        __localtime_r(&t, tm);
    }
    return t;
}
