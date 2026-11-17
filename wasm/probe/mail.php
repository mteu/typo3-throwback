<?php
// mail() as the Docker stacks have it: sendmail_path = /bin/true, so it
// returns true and nothing is sent. native/popen.c runs /bin/true, and
// nothing else.
//
// Usage: php -n mail.php            the compiled-in sendmail_path
//        php -n -d sendmail_path=/usr/sbin/sendmail mail.php refused

$errors = array();
function collect_error($level, $message) {
    $GLOBALS['errors'][] = $message;
}
set_error_handler('collect_error');

$failures = 0;
function expect($label, $ok) {
    global $failures, $errors;
    echo ($ok ? 'ok   ' : 'FAIL ') . $label . "\n";
    if (!$ok) {
        $failures++;
        foreach ($errors as $error) {
            echo "     $error\n";
        }
    }
    $errors = array();
}

$refused = isset($argv[1]) && $argv[1] == 'refused';

expect('mail() exists', function_exists('mail'));

if ($refused) {
    expect('a sendmail_path other than /bin/true: mail() is false, with PHP\'s warning',
        mail('to@example.com', 'Subject', 'Body') === false
        && count($errors) == 1 && strpos($errors[0], "Could not execute mail delivery program '/usr/sbin/sendmail'") !== false);
} else {
    expect('the compiled-in sendmail_path is /bin/true', strpos(ini_get('sendmail_path'), '/bin/true -t -i') === 0);
    expect('mail() returns true and warns of nothing', mail('to@example.com', 'Subject', 'Body') === true && !$errors);
    expect('with headers and a fifth argument, escaped by mail(): true',
        mail('to@example.com', 'Subject', 'Body', 'From: from@example.com', '-f from@example.com;x') === true && !$errors);

    $pipe = popen('/bin/true', 'w');
    expect('popen("/bin/true", "w") takes what is written', is_resource($pipe) && fwrite($pipe, 'discarded') == 9);
    expect('and closes with exit status 0', pclose($pipe) === 0);

    $output = array();
    $status = -1;
    $last = exec('/bin/true', $output, $status);
    expect('exec("/bin/true") prints nothing and exits 0', $last === '' && $output === array() && $status === 0);

    foreach (array('/bin/false', '/bin/truex', 'true', '/bin/true; /bin/false', '/bin/true | cat', '/bin/true `id`', '/bin/true $(id)') as $command) {
        expect("popen() refuses '$command', as for every program but /bin/true", @popen($command, 'r') === false);
    }
}

echo $failures == 0 ? "MAIL OK\n" : "mail: $failures failed\n";
exit($failures == 0 ? 0 : 1);
?>
