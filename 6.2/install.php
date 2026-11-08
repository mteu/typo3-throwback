<?php
/**
 * Drives TYPO3 6.2's own step installer, non-interactively, on first boot.
 *
 * The older stacks build their schema themselves, by merging ext_tables.sql files
 * the way their Install Tool did. That stops working at 6.2, for two reasons
 * docs/how-it-works.md sets out:
 *
 *   - 6.2 will not boot from a configuration file alone. Bootstrap.php:188
 *     redirects to the installer unless LocalConfiguration.php *and*
 *     PackageStates.php exist, and the package list a fresh site has is decided
 *     by each package's own metadata (isPartOfFactoryDefault), not by a list a
 *     script could copy.
 *   - Part of the schema is not in any SQL file. The caching framework's tables
 *     and the category fields are added at run time, through the
 *     tablesDefinitionIsBeingBuilt signal, by code that only runs inside a booted
 *     6.2 (SqlExpectedSchemaService::getTablesDefinitionString()).
 *
 * So this does what a person at a browser did in 2017: it walks the five steps of
 * typo3/sysext/install/Start/Install.php, posting what each form asks for, with
 * the form's own token, and following each 303 the installer answers with. What
 * comes out is the installer's own LocalConfiguration.php, PackageStates.php,
 * schema, static data and admin user, and nothing here has to know what they are.
 *
 * It talks to the container's own Apache over loopback, started for this by the
 * entrypoint and stopped again after, so the installer runs under the same SAPI
 * and the same php.ini the site will.
 *
 * Plain PHP streams rather than ext/curl, so that it depends on nothing the image
 * does not need anyway. PHP 5.6 syntax, because it runs on the image's PHP.
 */

function out($msg) {
    echo '[install] ' . $msg . "\n";
    flush();
}

function fail($msg) {
    echo '[install] ERROR: ' . $msg . "\n";
    exit(1);
}

function env($name, $default = '') {
    $v = getenv($name);
    return ($v === false || $v === '') ? $default : $v;
}

$base = 'http://127.0.0.1/typo3/sysext/install/Start/';

$cookies = array();

/**
 * One request, no redirects followed: the 303s are the installer's way of moving
 * between steps, and following them here keeps the cookie jar in our hands.
 *
 * @return array{0: int, 1: string|null, 2: string} status, Location, body
 */
function request($method, $url, $fields = array()) {
    global $cookies;

    $headers = array('User-Agent: typo3-throwback 6.2 installer driver');
    if ($cookies) {
        $pairs = array();
        foreach ($cookies as $name => $value) {
            $pairs[] = $name . '=' . $value;
        }
        $headers[] = 'Cookie: ' . implode('; ', $pairs);
    }

    $options = array(
        'method' => $method,
        'follow_location' => 0,
        'ignore_errors' => true,
        'timeout' => 300,
    );
    if ($method === 'POST') {
        $options['content'] = http_build_query($fields);
        $headers[] = 'Content-Type: application/x-www-form-urlencoded';
    }
    $options['header'] = implode("\r\n", $headers);

    $body = @file_get_contents($url, false, stream_context_create(array('http' => $options)));
    if ($body === false || !isset($http_response_header)) {
        fail($method . ' ' . $url . ' got no answer');
    }

    $status = 0;
    $location = null;
    foreach ($http_response_header as $line) {
        if (preg_match('#^HTTP/\S+ (\d{3})#', $line, $m)) {
            $status = (int) $m[1];
        } elseif (preg_match('/^Location:\s*(.+)$/i', $line, $m)) {
            $location = trim($m[1]);
        } elseif (preg_match('/^Set-Cookie:\s*([^=;\s]+)=([^;]*)/i', $line, $m)) {
            $cookies[$m[1]] = $m[2];
        }
    }

    return array($status, $location, $body);
}

/**
 * The hidden fields of the first form on a step page that names a step, by name.
 *
 * "First form that names a step" rather than "first form": when the environment
 * check finds anything, the first step's page leads with a bare "Fixed. Check
 * again!" form that posts nothing, and the one that continues comes second
 * (EnvironmentAndFolders.html). Attribute order differs between the templates
 * too (that one puts value before name), so each tag's attributes are read as a
 * set.
 *
 * @return array<string, string>
 */
function hiddenFields($body) {
    preg_match_all('#<form\b.*?</form>#s', $body, $forms);
    foreach ($forms[0] as $form) {
        $fields = array();
        preg_match_all('#<input\b[^>]*>#', $form, $inputs);
        foreach ($inputs[0] as $input) {
            preg_match_all('#(\w+)="([^"]*)"#', $input, $attributes, PREG_SET_ORDER);
            $a = array();
            foreach ($attributes as $attribute) {
                $a[$attribute[1]] = html_entity_decode($attribute[2], ENT_QUOTES, 'UTF-8');
            }
            if (isset($a['type'], $a['name']) && $a['type'] === 'hidden') {
                $fields[$a['name']] = isset($a['value']) ? $a['value'] : '';
            }
        }
        if (isset($fields['install[action]'])) {
            return $fields;
        }
    }

    return array();
}

function excerpt($body) {
    $text = trim(preg_replace('/\s+/', ' ', strip_tags(preg_replace('#<(script|style)\b.*?</\1>#s', '', $body))));
    return substr($text, 0, 1500);
}

/**
 * GET a URL and follow the installer's redirects to the page they end on.
 *
 * @return array{0: string, 1: string} the URL the page was served from, and the body
 */
function getFollowing($url) {
    global $base;
    for ($hops = 0; $hops < 12; $hops++) {
        list($status, $location, $body) = request('GET', $url);
        if ($status === 200) {
            return array($url, $body);
        }
        if ($status < 300 || $status >= 400 || $location === null) {
            fail('GET ' . $url . ' answered ' . $status . ': ' . excerpt($body));
        }
        $url = resolve($location);
    }
    fail('too many redirects from ' . $url);
}

function resolve($location) {
    global $base;
    if (preg_match('#^https?://#', $location)) {
        return $location;
    }
    return $base . $location;
}

$values = array(
    'databaseConnect' => array(
        'username' => env('TYPO3_DB_USER', 'typo3'),
        'password' => env('TYPO3_DB_PASSWORD', 'typo3'),
        'host' => env('TYPO3_DB_HOST', 'db'),
        'port' => '3306',
    ),
    // "existing", not "new": the official mysql image has already created the
    // database, so this is the choice a person would have made. The installer
    // accepts it only while the database is empty (DatabaseSelect.php, execute()).
    'databaseSelect' => array(
        'type' => 'existing',
        'existing' => env('TYPO3_DB_NAME', 'typo3'),
    ),
    // The installer refuses an admin password under eight characters
    // (DatabaseData.php, execute()); "password" is exactly eight.
    'databaseData' => array(
        'username' => env('TYPO3_ADMIN_USER', 'admin'),
        'password' => env('TYPO3_ADMIN_PASSWORD', 'password'),
        'sitename' => env('TYPO3_SITENAME', 'TYPO3 6.2.31'),
    ),
    // No "loaddistributions": that only sends the admin to the distribution list
    // on first login, which a stack with no egress cannot use.
    'defaultConfiguration' => array(),
    'environmentAndFolders' => array(),
);

$url = $base . 'Install.php';
$previous = '';
$done = array();

for ($round = 0; $round < 12; $round++) {
    list($url, $body) = getFollowing($url);
    $fields = hiddenFields($body);
    $action = isset($fields['install[action]']) ? $fields['install[action]'] : '';

    if (!isset($values[$action])) {
        fail('expected a step form, got action "' . $action . '": ' . excerpt($body));
    }
    if ($action === $previous) {
        fail('the installer showed "' . $action . '" again after it was posted: ' . excerpt($body));
    }

    $post = $fields;
    $post['install[set]'] = 'execute';
    foreach ($values[$action] as $name => $value) {
        $post['install[values][' . $name . ']'] = $value;
    }

    out('step ' . (count($done) + 1) . ': ' . $action);

    // What 6.2's own environment check thinks of this image, logged rather than
    // judged: it is the installer's verdict on PHP 5.6, one minor past what 6.2
    // supports.
    if ($action === 'environmentAndFolders') {
        if (strpos($body, 'I know what I') !== false) {
            out('the environment check reported errors or warnings: ' . excerpt($body));
        } else {
            out('the environment check reported nothing: "System looks good"');
        }
    }
    list($status, $location, $answer) = request('POST', $url, $post);
    if ($status < 300 || $status >= 400 || $location === null) {
        fail('posting "' . $action . '" answered ' . $status . ': ' . excerpt($answer));
    }

    $done[] = $action;
    $previous = $action;

    // The last step sends the browser to the site (DefaultConfiguration.php,
    // execute()), which is how the installer says it is finished.
    if ($action === 'defaultConfiguration') {
        if (strpos($location, 'index.php') === false || strpos($location, 'Install.php') !== false) {
            fail('defaultConfiguration redirected to ' . $location . ', not to the site');
        }
        out('installer finished after ' . implode(', ', $done) . '; it sent the browser to ' . $location);
        exit(0);
    }

    $url = resolve($location);
}

fail('the installer did not finish within ' . $round . ' steps: ' . implode(', ', $done));
