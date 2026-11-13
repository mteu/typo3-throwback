<?php
echo "before the fatal\n";
call_to_a_function_that_does_not_exist();
echo "never\n";
