# Security policy

## What is not a vulnerability here

The stacks in this repository run TYPO3 3.3.0 to 6.2.31 on PHP 4.4.9 and PHP 5.6.40,
with MySQL 5.5. Those releases have years of known, unpatched flaws, including remote
code execution. That is the point of the project. Reports about them, or about the
CVE counts on [the vulnerability page](docs/vulnerabilities.md), are out of scope.

The default credentials (`admin` / `password`, and the Install Tool password
`joh316`) are public on purpose and are not secrets.

## What is in scope

A flaw in what this project adds around those releases:

- a compose file that publishes a port beyond `127.0.0.1`
- an application container that can reach the network when it should not
- a build step that downloads or runs something it has not verified
- a workflow that leaks a token, or lets a pull request run with write access

## How to report

Use GitHub's private vulnerability reporting. On the repository page, open
the Security tab and choose "Report a vulnerability".

Please do not open a public issue for a flaw in scope.
