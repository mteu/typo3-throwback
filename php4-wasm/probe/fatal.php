<?php
// A fatal error makes the Zend engine longjmp out of execution (zend_bailout).
// Under Emscripten that needs working setjmp/longjmp, and the shutdown function
// proves the engine unwound cleanly rather than trapping.

function report_shutdown()
{
    echo "shutdown function ran after fatal\n";
}

register_shutdown_function('report_shutdown');
echo "before\n";
undefined_function_call();
echo "never\n";
