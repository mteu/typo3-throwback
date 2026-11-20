<?php
// mail() as the Docker stacks have it: sendmail_path = /bin/true, so it
// returns true and nothing is sent. native/popen.c runs /bin/true, answers
// for a program that is not there as sh does, and runs nothing else.
//
// Usage: php -n mail.php                         the compiled-in sendmail_path
//        php -n -d sendmail_path=sendmail mail.php refused

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
    expect('a sendmail_path that would run a program: mail() is false, with PHP\'s warning',
        mail('to@example.com', 'Subject', 'Body') === false
        && count($errors) == 1 && strpos($errors[0], "Could not execute mail delivery program 'sendmail'") !== false);
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

    // As TYPO3 6.2's Install Tool asks for ImageMagick's version, which its
    // Docker image does not have. sh says the program is not found and exits
    // 127; PHP returns that, with no output and no warning.
    foreach (array("'/nonexistent/identify' -version", '/nonexistent/identify -version') as $command) {
        $output = array();
        $status = -1;
        $last = exec($command, $output, $status);
        expect("exec(\"$command\"), a program that is not there, prints nothing and exits 127, as sh does",
            $last === '' && $output === array() && $status === 127 && !$errors);
    }

    foreach (array('/bin/false', 'true', 'identify -version', '/bin/true; /bin/false', '/bin/true | cat',
                   '/bin/true `id`', '/bin/true $(id)', '/nonexistent/identify | cat', "'/nonexistent/identify") as $command) {
        expect("popen() refuses '$command', as for every program but /bin/true and one that is not there", @popen($command, 'r') === false);
    }
}

echo $failures == 0 ? "MAIL OK\n" : "mail: $failures failed\n";
exit($failures == 0 ? 0 : 1);
?>
